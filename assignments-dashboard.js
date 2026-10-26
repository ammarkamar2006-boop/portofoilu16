(function () {
  const ASSIGNMENTS_KEY = 'alamin_ai_assignments';
  const SUBMISSIONS_KEY = 'alamin_ai_assignment_submissions';
  let assignments = JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '[]');
  let submissions = JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) || '[]');
  let selectedAssignmentId = null;

  const $ = id => document.getElementById(id);
  const esc = value => (typeof escHtml === 'function' ? escHtml(value) : String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])));
  const nowIso = () => new Date().toISOString();
  const toNum = (id, fallback = 0) => Number($(id)?.value || fallback) || fallback;

  function saveLocal() {
    localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions));
  }

  function totalScoreFromForm() {
    return toNum('asBaseScore') + toNum('asVerificationScore') + toNum('asQualityScore');
  }

  window.updateAssignmentTotalPreview = function () {
    const total = totalScoreFromForm();
    if ($('asTotalScore')) $('asTotalScore').value = total;
  };

  function fillGradeOptions() {
    const grade = $('asGrade');
    if (!grade) return;
    grade.innerHTML = typeof buildGradeOptions === 'function'
      ? buildGradeOptions('', false)
      : '<option value="1">الأول الثانوي</option><option value="2">الثاني الثانوي</option><option value="3">الثالث الثانوي</option>';
  }

  function nextAssignmentId() {
    return 'AS_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function dateForInput(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function formatDate(value) {
    if (!value) return 'غير محدد';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('ar-EG');
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
      reader.readAsDataURL(file);
    });
  }

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'انتهت مهلة العملية')), ms))
    ]);
  }

  async function compressImage(file, maxWidth = 1300, quality = 0.78) {
    const dataUrl = await withTimeout(readFileAsDataUrl(file), 10000, 'استغرقت قراءة الملف وقتاً طويلاً');
    if (!file.type.startsWith('image/')) return dataUrl;
    return withTimeout(new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    }), 10000, 'استغرق ضغط الصورة وقتاً طويلاً');
  }

  async function uploadAssignmentFile(file, assignmentId) {
    const isImage = file.type.startsWith('image/');
    let dataUrl = isImage ? await compressImage(file) : await withTimeout(readFileAsDataUrl(file), 10000, 'استغرقت قراءة الملف وقتاً طويلاً');
    const meta = {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: dataUrl.length < 700000 ? dataUrl : '',
      createdAt: nowIso()
    };
    if (window.storage) {
      try {
        const safeName = file.name.replace(/[^\w.\u0600-\u06FF-]+/g, '_');
        const ref = window.storage.ref().child(`assignments/${assignmentId}/answer-key/${Date.now()}_${safeName}`);
        await withTimeout(ref.putString(dataUrl, 'data_url'), 12000, 'رفع الملف إلى Firebase Storage استغرق وقتاً طويلاً');
        meta.url = await withTimeout(ref.getDownloadURL(), 8000, 'تعذر جلب رابط الملف من Firebase Storage');
      } catch (e) {
        console.warn('Assignment file upload failed, using inline fallback:', e);
        if (isImage && dataUrl.length >= 700000) {
          dataUrl = await compressImage(file, 900, 0.58);
          meta.dataUrl = dataUrl.length < 700000 ? dataUrl : meta.dataUrl;
        }
        meta.uploadWarning = e.message || 'تعذر رفع الملف إلى Storage، وتم حفظه كنسخة مضغوطة إن أمكن.';
      }
    }
    return meta;
  }

  window.openAssignmentModal = function (id = null) {
    fillGradeOptions();
    $('assignmentModalTitle').textContent = id ? 'تعديل الواجب الذكي ✏️' : 'إنشاء واجب ذكي 📒';
    $('asAssignmentId').value = id || nextAssignmentId();
    $('asTitle').value = '';
    $('asDescription').value = '';
    $('asBaseScore').value = 50;
    $('asVerificationScore').value = 10;
    $('asQualityScore').value = 0;
    $('asVerificationCount').value = 3;
    $('asQuestionSeconds').value = 10;
    $('asMaxSubmissionFiles').value = 5;
    $('asCloseAt').value = '';
    $('asAnswerText').value = '';
    $('asAnswerFiles').value = '';
    $('asFileHint').textContent = 'يمكن رفع عدة صور أو PDF أو نص. سيتم حفظها وربطها بالواجب لاستخدام Gemini في التصحيح.';

    const item = assignments.find(a => String(a.id) === String(id));
    if (item) {
      $('asTitle').value = item.title || '';
      $('asGrade').value = item.grade || '1';
      $('asDescription').value = item.description || '';
      $('asBaseScore').value = item.baseScore ?? 50;
      $('asVerificationScore').value = item.verificationScore ?? 10;
      $('asQualityScore').value = item.qualityScore ?? 0;
      $('asVerificationCount').value = item.verificationCount || 3;
      $('asQuestionSeconds').value = item.questionSeconds || 10;
      $('asMaxSubmissionFiles').value = item.maxSubmissionFiles || 5;
      $('asCloseAt').value = dateForInput(item.closeAt);
      $('asAnswerText').value = item.answerKeyText || '';
      $('asFileHint').textContent = `${(item.answerKeyFiles || []).length} ملف محفوظ حالياً. رفع ملفات جديدة سيضيفها إلى الموجود.`;
    }
    updateAssignmentTotalPreview();
    $('assignmentModal').classList.add('open');
  };

  window.saveAssignment = async function () {
    const btn = $('assignmentSaveBtn');
    const id = $('asAssignmentId').value || nextAssignmentId();
    const title = $('asTitle').value.trim();
    if (!title) { alert('برجاء إدخال اسم الواجب.'); return; }
    const existing = assignments.find(a => String(a.id) === String(id));
    const files = Array.from($('asAnswerFiles').files || []);
    btn.disabled = true;
    btn.textContent = 'جاري حفظ الواجب...';
    try {
      const uploaded = [];
      for (let i = 0; i < files.length; i++) {
        btn.textContent = `جاري تجهيز الملف ${i + 1} من ${files.length}...`;
        uploaded.push(await uploadAssignmentFile(file, id));
      }
      btn.textContent = 'جاري حفظ بيانات الواجب...';
      const payload = {
        ...(existing || {}),
        id,
        title,
        description: $('asDescription').value.trim(),
        grade: $('asGrade').value,
        baseScore: toNum('asBaseScore', 50),
        verificationScore: toNum('asVerificationScore', 10),
        qualityScore: toNum('asQualityScore', 0),
        totalScore: totalScoreFromForm(),
        verificationCount: toNum('asVerificationCount', 3),
        questionSeconds: toNum('asQuestionSeconds', 10),
        maxSubmissionFiles: toNum('asMaxSubmissionFiles', 5),
        answerKeyText: $('asAnswerText').value.trim(),
        answerKeyFiles: [...(existing?.answerKeyFiles || []), ...uploaded],
        closeAt: $('asCloseAt').value ? new Date($('asCloseAt').value).toISOString() : '',
        isPublished: true,
        updatedAt: nowIso()
      };
      if (!existing) payload.createdAt = nowIso();
      const idx = assignments.findIndex(a => String(a.id) === String(id));
      if (idx > -1) assignments[idx] = payload; else assignments.push(payload);
      saveLocal();
      let remoteSaved = false;
      if (window.db) {
        try {
          await withTimeout(
            window.db.collection('assignments').doc(String(id)).set(payload, { merge: true }),
            15000,
            'حفظ Firebase استغرق وقتاً طويلاً'
          );
          remoteSaved = true;
        } catch (e) {
          console.warn('Assignment Firestore save failed/timeout; local copy kept:', e);
        }
      }
      closeModal('assignmentModal');
      renderAssignmentsTable();
      const hasUploadWarning = uploaded.some(f => f.uploadWarning);
      if (!remoteSaved && window.db) {
        alert('تم حفظ الواجب محلياً، لكن حفظه على Firebase لم يكتمل بسبب بطء الاتصال. جرّب فتح الصفحة أو الحفظ مرة أخرى بعد ثوانٍ.');
      } else if (hasUploadWarning) {
        alert('تم حفظ الواجب ✅\nتنبيه: بعض الملفات لم تُرفع إلى Storage بسبب بطء/صلاحيات التخزين، لكن تم حفظ نسخة مضغوطة منها إن أمكن.');
      } else {
        alert('تم حفظ الواجب الذكي بنجاح ✅');
      }
    } catch (e) {
      console.error(e);
      alert('تعذر حفظ الواجب: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = 'حفظ الواجب ✅';
    }
  };

  window.deleteAssignment = async function (id) {
    if (!confirm('هل تريد حذف هذا الواجب؟ لن يتم حذف التسليمات المحفوظة إلا من العرض المحلي.')) return;
    assignments = assignments.filter(a => String(a.id) !== String(id));
    saveLocal();
    if (window.db) {
      try { await window.db.collection('assignments').doc(String(id)).delete(); } catch (e) { console.warn(e); }
    }
    if (selectedAssignmentId === id) selectedAssignmentId = null;
    renderAssignmentsTable();
    renderAssignmentSubmissionsTable();
  };

  window.selectAssignmentSubmissions = async function (id) {
    selectedAssignmentId = id;
    await syncAssignmentSubmissionsFromFirebase(id);
    renderAssignmentSubmissionsTable();
  };

  window.renderAssignmentsTable = function () {
    const tbody = $('assignmentsTableBody');
    if (!tbody) return;
    const term = ($('assignmentSearchInput')?.value || '').trim().toLowerCase();
    const rows = assignments.filter(a => !term || String(a.title || '').toLowerCase().includes(term));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">📒</div><p>لا توجد واجبات بعد</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(a => {
      const count = submissions.filter(s => String(s.assignmentId) === String(a.id)).length;
      const closed = a.closeAt && new Date(a.closeAt).getTime() < Date.now();
      return `<tr>
        <td><strong>${esc(a.title)}</strong><br><span style="font-size:11px;color:var(--text2);direction:ltr;display:inline-block">${esc(a.id)}</span></td>
        <td><span class="badge ${gradeClass(a.grade)}">${gradeLabel(a.grade)}</span></td>
        <td>${a.baseScore || 0} + ${a.verificationScore || 0} + ${a.qualityScore || 0} = <strong>${a.totalScore || 0}</strong></td>
        <td>${a.verificationCount || 3} أسئلة × ${a.questionSeconds || 10} ثانية</td>
        <td><span style="color:${closed ? 'var(--danger)' : 'var(--text)'}">${formatDate(a.closeAt)}</span></td>
        <td><strong>${count}</strong> تسليم</td>
        <td><div class="action-btns" style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-view" onclick="selectAssignmentSubmissions('${esc(a.id)}')" style="padding:6px 10px">عرض التسليمات</button>
          <button class="btn-view" onclick="openAssignmentModal('${esc(a.id)}')" style="padding:6px 10px;background:#8B6914;color:#fff">تعديل</button>
          <button class="btn-delete" onclick="deleteAssignment('${esc(a.id)}')" style="padding:6px 10px">حذف</button>
        </div></td>
      </tr>`;
    }).join('');
  };

  function scoreInput(id, field, value, max) {
    return `<input type="number" value="${Number(value || 0).toFixed(1)}" min="0" max="${max || 999}" step="0.5" onchange="updateSubmissionScore('${esc(id)}','${field}',this.value)" style="width:74px;padding:7px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)">`;
  }

  window.renderAssignmentSubmissionsTable = function () {
    const tbody = $('assignmentSubmissionsTableBody');
    if (!tbody) return;
    const assignment = assignments.find(a => String(a.id) === String(selectedAssignmentId));
    $('assignmentSubmissionsTitle').textContent = assignment ? `تسليمات: ${assignment.title}` : 'تسليمات الطلاب';
    if (!assignment) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">📭</div><p>اختر واجباً لعرض التسليمات</p></div></td></tr>';
      return;
    }
    const term = ($('assignmentSubmissionSearchInput')?.value || '').trim().toLowerCase();
    const rows = submissions
      .filter(s => String(s.assignmentId) === String(assignment.id))
      .filter(s => !term || String(s.studentCode || '').toLowerCase().includes(term) || String(s.studentName || '').toLowerCase().includes(term));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">📭</div><p>لا توجد تسليمات لهذا الواجب بعد</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(s => {
      const files = (s.files || []).slice(0, 5).map(f => `<a href="${esc(f.url || f.dataUrl || '#')}" target="_blank"><img src="${esc(f.url || f.dataUrl || '')}" style="width:54px;height:54px;object-fit:cover;border-radius:8px;border:1px solid var(--border);margin:2px;background:#fff"></a>`).join('');
      const final = Number(s.finalScore || 0).toFixed(1);
      return `<tr>
        <td><strong>${esc(s.studentName || 'غير معروف')}</strong><br><span style="font-size:11px;color:var(--text2)">${formatDate(s.submittedAt)}</span></td>
        <td><code>${esc(s.studentCode || '—')}</code></td>
        <td>${files || '—'}</td>
        <td><div style="max-width:260px;max-height:120px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.6">${esc(s.extractedText || '—')}</div></td>
        <td style="white-space:nowrap">
          واجب: ${scoreInput(s.id, 'homeworkScore', s.homeworkScore, assignment.baseScore)} / ${assignment.baseScore}<br>
          تحقق: ${scoreInput(s.id, 'verificationScoreValue', s.verificationScoreValue, assignment.verificationScore)} / ${assignment.verificationScore}<br>
          جودة: ${scoreInput(s.id, 'qualityScoreValue', s.qualityScoreValue, assignment.qualityScore)} / ${assignment.qualityScore}<br>
          <strong>النهائي: ${final} / ${assignment.totalScore}</strong>
        </td>
        <td>
          <strong>${esc(s.understandingLevel || '—')}</strong><br>
          ثقة: ${Number(s.confidence || 0).toFixed(0)}%
        </td>
        <td><div style="max-width:240px;white-space:pre-wrap;font-size:12px;line-height:1.6">${esc(s.aiNotes || s.generalEvaluation || '—')}</div></td>
        <td>
          <button class="btn-view" onclick="approveAssignmentSubmission('${esc(s.id)}')" style="padding:7px 10px;background:${s.approved ? '#16a34a' : '#0ea5e9'};color:#fff">${s.approved ? 'معتمد' : 'اعتماد'}</button>
        </td>
      </tr>`;
    }).join('');
  };

  window.updateSubmissionScore = async function (id, field, value) {
    const item = submissions.find(s => String(s.id) === String(id));
    if (!item) return;
    item[field] = Number(value) || 0;
    item.finalScore = (Number(item.homeworkScore) || 0) + (Number(item.verificationScoreValue) || 0) + (Number(item.qualityScoreValue) || 0);
    item.manualReviewed = true;
    item.updatedAt = nowIso();
    saveLocal();
    if (window.db) {
      try { await window.db.collection('assignment_submissions').doc(String(id)).set(item, { merge: true }); } catch (e) { console.warn(e); }
    }
    renderAssignmentSubmissionsTable();
  };

  window.approveAssignmentSubmission = async function (id) {
    const item = submissions.find(s => String(s.id) === String(id));
    if (!item) return;
    item.approved = true;
    item.approvedAt = nowIso();
    saveLocal();
    if (window.db) {
      try { await window.db.collection('assignment_submissions').doc(String(id)).set(item, { merge: true }); } catch (e) { console.warn(e); }
    }
    renderAssignmentSubmissionsTable();
  };

  async function syncAssignmentsFromFirebase() {
    if (!window.db) return;
    try {
      const snap = await window.db.collection('assignments').get();
      assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
    } catch (e) { console.warn('Assignments sync failed:', e); }
  }

  async function syncAssignmentSubmissionsFromFirebase(assignmentId = null) {
    if (!window.db) return;
    try {
      let ref = window.db.collection('assignment_submissions');
      if (assignmentId) ref = ref.where('assignmentId', '==', String(assignmentId));
      const snap = await ref.get();
      const incoming = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const rest = assignmentId ? submissions.filter(s => String(s.assignmentId) !== String(assignmentId)) : [];
      submissions = assignmentId ? rest.concat(incoming) : incoming;
      localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions));
    } catch (e) { console.warn('Assignment submissions sync failed:', e); }
  }

  window.renderAssignmentsPage = async function () {
    fillGradeOptions();
    await syncAssignmentsFromFirebase();
    await syncAssignmentSubmissionsFromFirebase(selectedAssignmentId);
    renderAssignmentsTable();
    renderAssignmentSubmissionsTable();
  };

  window.addEventListener('load', () => {
    setTimeout(() => {
      syncAssignmentsFromFirebase().then(renderAssignmentsTable);
      syncAssignmentSubmissionsFromFirebase().then(renderAssignmentSubmissionsTable);
    }, 1300);
  });
})();
