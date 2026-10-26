/**
 * grade-mapping.js
 * ============================================================
 *  نظام توحيد السنوات الدراسية بين السيستم (بوابة الحضور) والمنصة
 *
 *  القاعدة:
 *   • GRADE_MAP  →  المرجع الوحيد لكل السنوات
 *   • systemCode  =  القيمة المخزّنة في localStorage وFirestore للسيستم
 *   • platformCode = القيمة التي تفهمها المنصة (register.html / lessons / courses)
 *   • label       = الاسم العربي الكامل للعرض
 *   • shortLabel  = اسم مختصر للبادجات
 * ============================================================
 */

const GRADE_MAP = [
  // ─── كورسات الكبار (Adult English Courses) ────────────────────────
  { systemCode: 'pre-a1',       platformCode: 'pre-a1',       label: 'Pre-A1 (للمبتدئين تمامًا)',     shortLabel: 'Pre-A1' },
  { systemCode: 'a1',           platformCode: 'a1',           label: 'A1 (مبتدئ)',                    shortLabel: 'A1' },
  { systemCode: 'a2',           platformCode: 'a2',           label: 'A2 (ما دون المتوسط)',           shortLabel: 'A2' },
  { systemCode: 'b1',           platformCode: 'b1',           label: 'B1 (متوسط)',                   shortLabel: 'B1' },
  { systemCode: 'b2',           platformCode: 'b2',           label: 'B2 (فوق المتوسط)',              shortLabel: 'B2' },
  { systemCode: 'c1',           platformCode: 'c1',           label: 'C1 (متقدم)',                   shortLabel: 'C1' },

  // ─── كورسات الأطفال (Kids English Courses) ────────────────────────
  { systemCode: 'phonics',      platformCode: 'phonics',      label: 'Phonics Course (تعليم الأصوات)', shortLabel: 'Phonics' },
  { systemCode: 'kids-level-1', platformCode: 'kids-level-1', label: 'Kids Level 1 (المستوى الأول)',  shortLabel: 'Kids 1' },
  { systemCode: 'kids-level-2', platformCode: 'kids-level-2', label: 'Kids Level 2 (المستوى الثاني)', shortLabel: 'Kids 2' },
  { systemCode: 'kids-level-3', platformCode: 'kids-level-3', label: 'Kids Level 3 (المستوى الثالث)', shortLabel: 'Kids 3' }
];

// ─── جدول التوافق وترحيل القيم السابقة تلقائياً إلى مستويات الأكاديمية ──
const LEGACY_TO_SYSTEM = {
  // قيم الكورسات بالإنجليزية
  'Pre-A1': 'pre-a1', 'pre-a1': 'pre-a1',
  'A1': 'a1', 'a1': 'a1',
  'A2': 'a2', 'a2': 'a2',
  'B1': 'b1', 'b1': 'b1',
  'B2': 'b2', 'b2': 'b2',
  'C1': 'c1', 'c1': 'c1',
  'Phonics': 'phonics', 'phonics': 'phonics',
  'Kids Level 1': 'kids-level-1', 'kids-level-1': 'kids-level-1',
  'Kids Level 2': 'kids-level-2', 'kids-level-2': 'kids-level-2',
  'Kids Level 3': 'kids-level-3', 'kids-level-3': 'kids-level-3',
  // ترحيل القيم القديمة من المدارس المصرية إلى فئات الكورسات
  '1': 'a1', '2': 'a2', '3': 'b1',
  '10': 'a1', '11': 'a2', '12': 'b1',
  '301': 'a1', '302': 'a2', '303': 'b1',
  'First Secondary': 'a1', 'first-secondary': 'a1',
  'Second Secondary – Baccalaureate': 'a2', 'second-secondary': 'a2',
  'Third Secondary': 'b1', 'third-secondary': 'b1',
  'أولى ثانوي': 'a1', 'أول ثانوي': 'a1', 'أولي ثانوي': 'a1',
  'ثانية ثانوي': 'a2', 'تاني ثانوي': 'a2', 'ثاني ثانوي': 'a2',
  'ثالثة ثانوي': 'b1', 'تالت ثانوي': 'b1', 'ثالث ثانوي': 'b1',
  'prep1': 'phonics', 'prep2': 'kids-level-1', 'prep3': 'kids-level-2',
  'أولى إعدادي': 'phonics', 'ثانية إعدادي': 'kids-level-1', 'ثالثة إعدادي': 'kids-level-2'
};

// ─── دوال المساعدة ────────────────────────────────────────────

/** يُعيد entry كامل من GRADE_MAP بحسب systemCode أو قيمة legacy */
function getGradeEntry(rawCode) {
  if (!rawCode) return null;
  const code = String(rawCode).trim();
  // بحث مباشر
  let entry = GRADE_MAP.find(g => g.systemCode === code);
  if (entry) return entry;
  // بحث في legacy
  const mapped = LEGACY_TO_SYSTEM[code];
  if (mapped) return GRADE_MAP.find(g => g.systemCode === mapped) || null;
  return null;
}

/** systemCode → الاسم العربي الكامل */
function gradeLabel(systemCode) {
  const entry = getGradeEntry(systemCode);
  return entry ? entry.label : (systemCode || '');
}

/** systemCode → الكود الذي تفهمه المنصة */
function gradeToPlatformCode(systemCode) {
  const entry = getGradeEntry(systemCode);
  return entry ? entry.platformCode : String(systemCode || '');
}

/** platformCode → systemCode */
function platformCodeToSystem(platformCode) {
  const code = String(platformCode || '').trim();
  const entry = GRADE_MAP.find(g => g.platformCode === code);
  return entry ? entry.systemCode : code;
}

/** أي قيمة خام (legacy/platform/system) → systemCode نظيف */
function normalizeGrade(rawValue) {
  if (!rawValue) return '';
  const code = String(rawValue).trim();
  // هل هو systemCode مباشرة؟
  if (GRADE_MAP.find(g => g.systemCode === code)) return code;
  // هل هو platformCode؟
  const byPlatform = GRADE_MAP.find(g => g.platformCode === code);
  if (byPlatform) return byPlatform.systemCode;
  // هل هو legacy؟
  const byLegacy = LEGACY_TO_SYSTEM[code];
  if (byLegacy) return byLegacy;
  return code;
}

/**
 * يُوحّد بيانات طالب قادم من Firebase قبل حفظه محلياً.
 * يقرأ grade أو offlineGrade ويحوّلهما لـ systemCode.
 */
function normalizeImportedStudentGrade(data) {
  const candidates = [data.grade, data.offlineGrade, data.platformGrade];
  for (const c of candidates) {
    const normalized = normalizeGrade(c);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * يُحضّر كائن الطالب للإرسال إلى Firebase / المنصة.
 * يُضيف platformGrade و gradeLabel تلقائياً.
 */
function buildStudentExportPayload(studentObj) {
  const systemCode = normalizeGrade(studentObj.grade);
  const entry = getGradeEntry(systemCode);
  return {
    ...studentObj,
    grade: systemCode,               // systemCode المُنظَّف
    platformGrade: entry ? entry.platformCode : systemCode,  // للمنصة
    gradeLabel: entry ? entry.label : systemCode,            // للعرض
    offlineGrade: systemCode,        // توافق مع الكود القديم
  };
}

/** يُنشئ <option> elements لكل المستويات والكورسات */
function buildGradeOptions(selectedCode = '', includeAll = false) {
  let html = includeAll ? '<option value="all">كل المستويات والكورسات</option>' : '<option value="">اختر المستوى / الفئة</option>';
  const groups = [
    { label: 'كورسات الكبار — Adult English Courses', codes: ['pre-a1', 'a1', 'a2', 'b1', 'b2', 'c1'] },
    { label: 'كورسات الأطفال — Kids English Courses', codes: ['phonics', 'kids-level-1', 'kids-level-2', 'kids-level-3'] }
  ];
  groups.forEach(group => {
    html += `<optgroup label="${group.label}">`;
    group.codes.forEach(code => {
      const entry = GRADE_MAP.find(g => g.systemCode === code);
      if (!entry) return;
      const sel = (code === selectedCode) ? ' selected' : '';
      html += `<option value="${code}"${sel}>${entry.label}</option>`;
    });
    html += '</optgroup>';
  });
  return html;
}

/** gradeClass للـ badge (للتوافق مع الكود القديم) */
function gradeClass(systemCode) {
  const entry = getGradeEntry(systemCode);
  if (!entry) return 'grade1';
  const code = entry.systemCode;
  if (['phonics', 'kids-level-1', 'kids-level-2', 'kids-level-3'].includes(code)) return 'grade-prep';
  if (['pre-a1', 'a1'].includes(code)) return 'grade1';
  if (['a2', 'b1'].includes(code)) return 'grade2';
  return 'grade3';
}

// ─── تصدير global ────────────────────────────────────────────
window.GRADE_MAP                    = GRADE_MAP;
window.LEGACY_TO_SYSTEM             = LEGACY_TO_SYSTEM;
window.getGradeEntry                = getGradeEntry;
window.gradeLabel                   = gradeLabel;
window.gradeToPlatformCode          = gradeToPlatformCode;
window.platformCodeToSystem         = platformCodeToSystem;
window.normalizeGrade               = normalizeGrade;
window.normalizeImportedStudentGrade = normalizeImportedStudentGrade;
window.buildStudentExportPayload    = buildStudentExportPayload;
window.buildGradeOptions            = buildGradeOptions;
window.gradeClass                   = gradeClass;
