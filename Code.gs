/**
 * Lobby v2 — 말로 기록하고, 말로 묻고, 회사 문서를 읽고, 밤마다 보고하는 개인 비서
 * 백엔드: Google Apps Script (스프레드시트에 붙어 있는 스크립트)
 *
 * [v1 → v2 업데이트 방법]
 *  1) 이 코드를 Code.gs에 통째로 덮어써서 붙여넣고 저장
 *  2) 함수 목록에서 setup 선택 → 실행 → 권한 승인 (구글 드라이브·문서 권한이 새로 추가됩니다)
 *  3) 배포 > 배포 관리 > 연필(수정) > 버전: "새 버전" > 배포   ← 웹 앱 주소가 그대로 유지됩니다
 *
 * [처음 설치라면]
 *  - 스크립트 속성: ANTHROPIC_API_KEY, APP_PIN 추가 후 위 2)~3) 진행 (3은 "새 배포 > 웹 앱")
 *
 * setup이 하는 일
 *  - 시트 탭 생성: 기록·프로필·분류·대화로그·변경이력·휴지통·문서·문서조각·보고서·예약
 *  - 구글 드라이브에 "Lobby 문서" 폴더 생성 (여기에 승인원·작업표준서 등을 넣으면 자동으로 읽음)
 *  - 자동 실행 등록: 15분마다 예약 확인(밤 10시 보고서 포함), 1시간마다 문서 읽기, 새벽 4시 휴지통 정리
 */

// ───────────────────────── 설정 ─────────────────────────
const CONFIG = {
  MODEL: 'claude-sonnet-4-5',   // 말로업무일지에서 쓰시는 모델명과 맞춰 주세요
  TZ: 'Asia/Seoul',
  TRASH_DAYS: 30,               // 삭제 후 복구 가능 기간(일)
  LEARN_SCAN: 800,              // 입력 습관을 배울 때 살펴볼 최근 기록 수
  LEARN_EXAMPLES: 6,            // 새 입력 정리 시 참고용으로 보여 줄 비슷한 과거 기록 수
  KRW_PER_USD: 1400,            // 환율(원/달러). 사용 요금을 원화로 보여 줄 때 쓰는 값이라 대략 맞춰 두면 됩니다
  PRICE_PER_MTOK: {             // 모델별 [입력, 출력] 단가(달러 / 100만 토큰). 모델을 바꾸면 여기도 확인해 주세요
    'claude-sonnet-4-5': [3, 15], 'claude-haiku-4-5': [1, 5], 'claude-opus-4-5': [5, 25],
  },
  MONTH_BUDGET_KRW: 0,          // 월 예산(원). 0이면 끔. 정해 두면 80%·100%에서 화면의 금액 색이 바뀝니다
  MAX_ROWS_TO_AI: 150,          // 답변 작성 시 Claude에게 넘길 최대 기록 수
  DOCS_FOLDER_NAME: 'Lobby 문서',
  DAILY_REPORT_TIME: '22:00',
  BRIEF_TIME: '07:30',          // 아침 브리핑 시각 (앱의 보고 탭에서도 바꿀 수 있음)
  WEATHER: { name: '서울', lat: 37.5665, lon: 126.978 },   // 브리핑 날씨 지역 (위도·경도를 바꾸면 다른 지역)   // 오늘의 보고서 시각 (앱의 보고 탭에서도 바꿀 수 있음)
  CHUNK_SIZE: 1500,             // 문서를 나누는 조각 크기(글자)
  CHUNK_OVERLAP: 200,
  MAX_DOC_CHUNKS_TO_AI: 8,      // 답변에 넘길 문서 조각 수
  INDEX_BUDGET_MS: 270000,      // 자동 문서 읽기 1회 최대 시간(4.5분)
  PDF_AI_MAX_MB: 25,            // 글자를 못 뽑은 PDF를 Claude로 읽을 때 최대 크기
};

const SH = {
  RECORD: '기록', PROFILE: '프로필', CATEGORY: '분류',
  LOG: '대화로그', HISTORY: '변경이력', TRASH: '휴지통',
  DOCS: '문서', CHUNKS: '문서조각', REPORT: '보고서', TASKS: '예약', USAGE: '사용량',
};

const REC_HEADERS = ['ID', '입력일시', '대상일', '대상시각', '유형', '분류', '제목', '내용',
  '금액', '인물', '장소', '태그', '상태', '원문', '수정일시', '삭제일시'];
const COL = REC_HEADERS.reduce((o, h, i) => (o[h] = i, o), {});
const DOC_HEADERS = ['파일ID', '파일명', '형식', '수정일시', '조각수', '읽은일시', '상태', '링크'];
const CHUNK_HEADERS = ['파일ID', '파일명', '조각', '위치', '본문'];
const REPORT_HEADERS = ['ID', '생성일시', '종류', '제목', '음성요약', '상세', '읽음', '예약ID'];
const USAGE_HEADERS = ['날짜', '모델', '호출수', '입력토큰', '출력토큰', '금액(원)'];
const TASK_HEADERS = ['ID', '이름', '반복', '요일', '날짜', '시각', '요청', '활성', '마지막실행', '다음실행'];

const TYPES = ['일상', '지출', '일정', '업무일정', '정보', '특이점', '아이디어', '할일'];
const STATES = ['정상', '예정', '완료', '취소', '삭제'];
const EDITABLE = ['대상일', '대상시각', '유형', '분류', '제목', '내용', '금액', '인물', '장소', '태그', '상태'];
const REPEATS = ['매일', '매주', '매월', '한번'];
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const DAILY_ID = 'DAILY';
const BRIEF_ID = 'BRIEF';

const DEFAULT_CATEGORIES = [
  ['차량', '정비·주유·보험·세차'],
  ['생활', '장보기·생활용품·공과금'],
  ['미용/자기관리', '이발·운동·자기계발'],
  ['외식/모임', '외식·친구·동창 모임'],
  ['가족행사', '생일·기념일·가족 모임'],
  ['여가/취미', '골프·영화·취미 활동'],
  ['여행', '국내외 여행·숙박'],
  ['업무', '회사 일정·거래처·생산'],
  ['재테크', '주식·저축·투자'],
  ['앱개발', '앱 아이디어·개발 작업'],
];

// ───────────────────────── 초기 설정 ─────────────────────────
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TZ);

  ensureSheet_(ss, SH.RECORD, REC_HEADERS, ['A:D', 'O:P']);
  ensureSheet_(ss, SH.PROFILE, ['항목', '값', '갱신일'], ['C:C']);
  const cat = ensureSheet_(ss, SH.CATEGORY, ['분류명', '설명', '추가일'], ['C:C']);
  ensureSheet_(ss, SH.LOG, ['시각', '질문', '조회계획', '음성답변', '해당건수'], ['A:A']);
  ensureSheet_(ss, SH.HISTORY, ['시각', '기록ID', '칸', '이전값', '새값', '경로'], ['A:B']);
  ensureSheet_(ss, SH.TRASH, REC_HEADERS, ['A:D', 'O:P']);
  ensureSheet_(ss, SH.DOCS, DOC_HEADERS, ['A:A', 'D:D', 'F:F']);
  ensureSheet_(ss, SH.CHUNKS, CHUNK_HEADERS, ['A:A']);
  ensureSheet_(ss, SH.REPORT, REPORT_HEADERS, ['A:B', 'H:H']);
  ensureSheet_(ss, SH.TASKS, TASK_HEADERS, ['A:A', 'D:F', 'I:J']);
  ensureSheet_(ss, SH.USAGE, USAGE_HEADERS, ['A:B']);

  if (cat.getLastRow() < 2) {
    const today = fmt_(new Date(), 'yyyy-MM-dd');
    cat.getRange(2, 1, DEFAULT_CATEGORIES.length, 3)
      .setValues(DEFAULT_CATEGORIES.map(r => [r[0], r[1], today]));
  }

  // 오늘의 보고서(기본 예약)
  const tasks = getTasks_();
  if (!tasks.some(t => t.ID === DAILY_ID)) {
    const t = { ID: DAILY_ID, 이름: '오늘의 보고서', 반복: '매일', 요일: '', 날짜: '', 시각: CONFIG.DAILY_REPORT_TIME,
      요청: '__DAILY__', 활성: 'Y', 마지막실행: '', 다음실행: '' };
    t.다음실행 = nextRun_(t, new Date());
    saveTaskRow_(t);
  }

  // 아침 브리핑(기본 예약)
  if (!tasks.some(t => t.ID === BRIEF_ID)) {
    const t = { ID: BRIEF_ID, 이름: '아침 브리핑', 반복: '매일', 요일: '', 날짜: '', 시각: CONFIG.BRIEF_TIME,
      요청: '__BRIEF__', 활성: 'Y', 마지막실행: '', 다음실행: '' };
    t.다음실행 = nextRun_(t, new Date());
    saveTaskRow_(t);
  }

  // 문서 폴더
  const folder = getDocsFolder_();

  // 자동 실행 (중복 없이)
  const want = { purgeTrash: 'daily4', runScheduler: 'min15', indexDocs: 'hour1' };
  const have = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  if (have.indexOf('purgeTrash') < 0) ScriptApp.newTrigger('purgeTrash').timeBased().everyDays(1).atHour(4).create();
  if (have.indexOf('runScheduler') < 0) ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(15).create();
  if (have.indexOf('indexDocs') < 0) ScriptApp.newTrigger('indexDocs').timeBased().everyHours(1).create();

  const p = PropertiesService.getScriptProperties();
  const miss = ['ANTHROPIC_API_KEY', 'APP_PIN'].filter(k => !p.getProperty(k));
  Logger.log(miss.length ? '⚠ 스크립트 속성 누락: ' + miss.join(', ') : '✔ Lobby v2 설정 완료');
  Logger.log('📁 문서 폴더: ' + folder.getUrl());
  return Object.keys(want).length;
}

function ensureSheet_(ss, name, headers, textCols) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1F2530').setFontColor('#EDEFF3');
    sh.setFrozenRows(1);
  }
  (textCols || []).forEach(a1 => sh.getRange(a1).setNumberFormat('@'));
  return sh;
}

function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

// ───────────────────────── 웹 요청 ─────────────────────────
function doGet() {
  return json_({ ok: true, app: 'Lobby', version: 2, build: BUILD, actions: HANDLER_NAMES_(), msg: 'Lobby 서버가 동작 중입니다.' });
}

const BUILD = '2026-10-03 할일·브리핑';   // 배포된 코드가 최신인지 웹 앱 주소를 열어 확인하는 표식

function handlers_() {
  return {
    init: actInit_, parse: actParse_, save: actSave_,
    ask: r => actTalk_(Object.assign({}, r, { mode: 'question' })), talk: actTalk_,
    list: actList_, update: actUpdate_, 'delete': actDelete_, restore: actRestore_,
    docs: actDocs_, reindex: actReindex_,
    reports: actReports_, readReport: actReadReport_, deleteReport: actDeleteReport_, runDaily: actRunDaily_,
    saveTask: actSaveTask_, deleteTask: actDeleteTask_,
    todos: actTodos_, brief: actBrief_, usage: () => ({}),
  };
}
function HANDLER_NAMES_() { return Object.keys(handlers_()); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    const pin = PropertiesService.getScriptProperties().getProperty('APP_PIN');
    if (!pin || String(req.pin) !== String(pin)) return json_({ ok: false, error: '접속 암호가 맞지 않습니다.' });

    const handlers = handlers_();
    const fn = handlers[req.action];
    if (!fn) return json_({ ok: false, error: '알 수 없는 요청: ' + req.action });
    const out = Object.assign({ ok: true }, fn(req));
    out.usage = usageSummary_();                 // 요청이 끝날 때마다 최신 사용 요금을 함께 보낸다(화면 상단에 표시)
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── init ─────────────────────────
function actInit_() {
  return {
    version: 2, categories: getCategories_(), types: TYPES, states: STATES,
    today: fmt_(new Date(), 'yyyy-MM-dd'), recent: recent_(5),
    unread: getReports_(60).filter(r => r.읽음 !== 'Y').length,
    latestReport: getReports_(1)[0] || null,
    docCount: Math.max(0, sheet_(SH.DOCS).getLastRow() - 1),
    docsFolderUrl: getDocsFolder_().getUrl(),
  };
}

// ───────────────────────── 입력 습관 학습 ─────────────────────────
// 모델을 따로 훈련하지 않고, 카일님이 저장·확인한 기록을 "예시"로 보여 줘서 비슷한 말은 같은 방식으로 정리하게 한다.
// 기록이 쌓일수록 예시가 늘어나 정확해지고, 화면에서 유형·분류를 고친 기록은 더 높은 비중으로 참고한다.
function grams_(s) {
  // 숫자·금액·날짜·어미처럼 어떤 입력에나 나오는 말은 빼야 "비슷한 내용"만 걸러진다
  const t = String(s || '').toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/(오늘|어제|그저께|내일|모레|아침|점심|저녁|오전|오후|방금|지난주|이번주|했었|했어요|했는데|했어|했다|했음|갔다|갔어|왔어|왔다|했고|하고|에서|에게|으로|이랑|하고|만원|천원|킬로|원)/g, ' ')
    .replace(/[^0-9a-z가-힣]/g, '');
  const set = {}; let n = 0;
  for (let i = 0; i < t.length - 1; i++) { const g = t.substr(i, 2); if (!set[g]) { set[g] = 1; n++; } }
  return { set: set, n: n };
}
function similarity_(a, b) {
  if (!a.n || !b.n) return 0;
  let c = 0; Object.keys(a.set).forEach(g => { if (b.set[g]) c++; });
  return c >= 2 ? c / Math.sqrt(a.n * b.n) : 0;      // 겹치는 글자쌍이 2개 미만이면 우연의 일치로 본다
}

/** 화면에서 유형·분류를 고친 기록 → { 기록ID: '분류 차량→생활' } */
function correctionMap_() {
  const o = {};
  try {
    const sh = sheet_(SH.HISTORY);
    const n = sh.getLastRow() - 1;
    if (n < 1) return o;
    const take = Math.min(n, 300);
    sh.getRange(n + 2 - take, 1, take, 6).getValues().forEach(h => {
      if ((h[2] === '유형' || h[2] === '분류') && h[5] === '화면') o[String(h[1])] = h[2] + ' ' + h[3] + '→' + h[4];
    });
  } catch (e) { /* 이력이 없어도 학습은 계속 */ }
  return o;
}

function learnedHints_(text) {
  try {
    const all = getRecords_().filter(r => r.상태 !== '삭제').slice(-CONFIG.LEARN_SCAN);
    if (all.length < 3) return '';
    const fixes = correctionMap_();
    const q = grams_(text);

    const scored = all.map(r => {
      const src = String(r.원문 || (r.제목 + ' ' + r.내용));
      let s = similarity_(q, grams_(src));
      if (fixes[r.ID] || r.수정일시) s *= 1.3;          // 카일님이 직접 고친 기록은 더 믿을 만한 예시
      return { r: r, s: s, src: src };
    }).filter(x => x.s >= 0.15).sort((a, b) => b.s - a.s);

    const seen = {}, ex = [];
    scored.forEach(x => {
      const key = [x.r.유형, x.r.분류, x.r.제목].join('|');
      if (seen[key] || ex.length >= CONFIG.LEARN_EXAMPLES) return;
      seen[key] = 1;
      const r = x.r;
      ex.push('  "' + x.src.replace(/\s+/g, ' ').slice(0, 60) + '" → 유형=' + r.유형 + ', 분류=' + r.분류 + ', 제목="' + r.제목 + '"' +
        (r.태그 ? ', 태그=' + r.태그 : '') + (r.금액 !== null ? ', 금액 있음' : '') + (fixes[r.ID] ? '  (카일님이 고침: ' + fixes[r.ID] + ')' : ''));
    });

    // 전체 습관: 유형별로 자주 쓰는 분류, 자주 쓰는 태그
    const byType = {}, tags = {};
    all.forEach(r => {
      byType[r.유형] = byType[r.유형] || {}; byType[r.유형][r.분류] = (byType[r.유형][r.분류] || 0) + 1;
      String(r.태그 || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => tags[t] = (tags[t] || 0) + 1);
    });
    const top = o => Object.keys(o).sort((a, b) => o[b] - o[a]);
    const habit = Object.keys(byType).map(t => t + '→' + top(byType[t]).slice(0, 3).map(c => c + '(' + byType[t][c] + ')').join(', ')).join(' / ');
    const tagLine = top(tags).slice(0, 15).join(', ');

    const out = ['[카일님의 입력 습관 — 지금까지 저장·확인된 ' + all.length + '건에서 배운 것. 참고용이며 위 규칙·JSON 형식이 우선한다]'];
    if (ex.length) out.push('비슷했던 과거 입력(같은 방식으로 정리):', ex.join('\n'));
    if (habit) out.push('유형별 자주 쓰는 분류: ' + habit);
    if (tagLine) out.push('자주 쓰는 태그(같은 뜻이면 이 표현으로 통일): ' + tagLine);
    return out.join('\n');
  } catch (e) { return ''; }       // 학습이 실패해도 입력 정리는 평소처럼 동작
}

// ───────────────────────── 기록: 정리(parse) ─────────────────────────
function actParse_(req) {
  const text = mask_(String(req.text || '').trim());
  if (!text) throw new Error('말씀하신 내용이 비어 있습니다.');
  const cats = getCategories_();

  const system = [
    '너는 카일님의 개인 비서 Lobby다. 카일님의 음성 발화를 기록용 JSON으로 정리한다.',
    dateContext_(),
    '유형(8개 중 하나): ' + TYPES.join(', '),
    '  일상=있었던 일, 지출=돈을 쓴 기록(금액 필수), 일정=앞으로의 개인 약속, 업무일정=회사 약속·마감,',
    '  정보=기억해 둘 사실, 특이점=평소와 다른 일·주의할 일, 아이디어=떠오른 생각,',
    '  할일=앞으로 해야 할 일("~해야 돼", "~사야지", "~까먹지 말기"). 할일의 대상일은 기한이고, 기한 언급이 없으면 ""로 둔다.',
    '분류(기존): ' + cats.map(c => c.name).join(', '),
    '규칙:',
    '- 한 발화에 여러 건이 있으면 각각 나눈다. 호출어("로비야", "안녕 로비" 등)는 내용에서 뺀다.',
    '- 대상일은 yyyy-MM-dd. "어제"=오늘-1, "그저께"=오늘-2, "다음 주 X요일"=다음 주(월~일)의 X요일, "이번 주말"=이번 주 토요일(내용에 "주말" 표기), "다음 달 초"=다음 달 1일(내용에 "초순" 표기).',
    '- 날짜 언급이 없으면 일상·지출·정보·특이점·아이디어는 오늘(할일은 ""). 일정·업무일정인데 날짜가 없으면 대상일을 ""로 두고 확인필요에 질문을 적는다.',
    '- 대상시각은 HH:mm(24시간). 없으면 "".',
    '- 금액은 원 단위 정수. "8만5천"=85000. 없으면 null.',
    '- 제목은 20자 안팎 한 줄 요약, 내용은 정리된 본문(수치·조건 보존).',
    '- 상태: 일정·업무일정·할일은 "예정", 나머지는 "정상".',
    '- 태그는 검색용 핵심어 1~4개.',
    '- 기존 분류에 맞지 않으면 새 분류명을 제안하고 새분류=true, 분류설명에 한 줄 설명. 억지로 새 분류를 만들지 말 것.',
    '- 유형이 정보이고 "항목=값"으로 정리 가능하면 프로필항목/프로필값을 채운다(예: "차 타이어 규격" / "235/55R19").',
    '- 카드번호·계좌번호·비밀번호는 절대 옮겨 적지 말고 "***"로 가린다.',
    learnedHints_(text),
    '반드시 JSON만 출력:',
    '{"items":[{"유형":"","분류":"","새분류":false,"분류설명":"","대상일":"","대상시각":"","제목":"","내용":"","금액":null,"인물":[],"장소":"","태그":[],"상태":"","프로필항목":"","프로필값":"","확인필요":""}]}',
  ].join('\n');

  const out = extractJson_(callClaude_(system, text, 2000));
  const items = (out.items || []).map(it => normalizeItem_(it, cats));
  return { items: items, raw: text };
}

function normalizeItem_(it, cats) {
  const names = cats.map(c => c.name);
  const o = {
    유형: TYPES.indexOf(it.유형) >= 0 ? it.유형 : '일상',
    분류: String(it.분류 || '생활').trim(),
    대상일: String(it.대상일 || ''),
    대상시각: String(it.대상시각 || ''),
    제목: String(it.제목 || '').slice(0, 60),
    내용: String(it.내용 || ''),
    금액: toNum_(it.금액),
    인물: listStr_(it.인물),
    장소: String(it.장소 || ''),
    태그: listStr_(it.태그),
    상태: STATES.indexOf(it.상태) >= 0 ? it.상태 : (/일정|할일/.test(it.유형) ? '예정' : '정상'),
    프로필항목: String(it.프로필항목 || ''),
    프로필값: String(it.프로필값 || ''),
    확인필요: String(it.확인필요 || ''),
  };
  o.새분류 = names.indexOf(o.분류) < 0;
  o.분류설명 = o.새분류 ? String(it.분류설명 || '') : '';
  return o;
}

// ───────────────────────── 기록: 저장(save) ─────────────────────────
function actSave_(req) {
  const items = req.items || [];
  if (!items.length) throw new Error('저장할 기록이 없습니다.');
  const raw = mask_(String(req.raw || ''));
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SH.RECORD);
    const now = new Date();
    const nowStr = fmt_(now, 'yyyy-MM-dd HH:mm');
    const prefix = fmt_(now, 'yyyyMMdd');
    let seq = nextSeq_(sh, prefix);

    const known = getCategories_().map(c => c.name);
    const catSh = ss.getSheetByName(SH.CATEGORY);
    items.forEach(it => {
      if (it.새분류승인 && it.분류 && known.indexOf(it.분류) < 0) {
        catSh.appendRow([it.분류, it.분류설명 || '', fmt_(now, 'yyyy-MM-dd')]);
        known.push(it.분류);
      }
    });

    const rows = [], ids = [];
    items.forEach(it => {
      const id = prefix + '-' + ('00' + (seq++)).slice(-3);
      ids.push(id);
      const cat = known.indexOf(it.분류) >= 0 ? it.분류 : '생활';
      rows.push([
        id, nowStr, it.대상일 || (it.유형 === '할일' ? '' : fmt_(now, 'yyyy-MM-dd')), it.대상시각 || '',
        TYPES.indexOf(it.유형) >= 0 ? it.유형 : '일상', cat, mask_(it.제목 || ''), mask_(it.내용 || ''),
        toNum_(it.금액) === null ? '' : toNum_(it.금액),
        listStr_(it.인물), it.장소 || '', listStr_(it.태그),
        STATES.indexOf(it.상태) >= 0 ? it.상태 : '정상', raw, '', '',
      ]);
      if (it.유형 === '정보' && it.프로필항목 && it.프로필값) upsertProfile_(it.프로필항목, mask_(it.프로필값));
    });
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, REC_HEADERS.length).setValues(rows);
    return { ids: ids, recent: recent_(5) };
  } finally {
    lock.releaseLock();
  }
}

function nextSeq_(sh, prefix) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 1;
  const ids = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]));
  let max = 0;
  ids.forEach(id => { if (id.indexOf(prefix + '-') === 0) max = Math.max(max, parseInt(id.split('-')[1], 10) || 0); });
  return max + 1;
}

function upsertProfile_(key, val) {
  const sh = sheet_(SH.PROFILE);
  const today = fmt_(new Date(), 'yyyy-MM-dd');
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const keys = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim());
    const i = keys.indexOf(key.trim());
    if (i >= 0) { sh.getRange(i + 2, 2, 1, 2).setValues([[val, today]]); return; }
  }
  sh.appendRow([key, val, today]);
}

// ───────────────────────── 대화(talk): 의도 판단 → 기록 / 질문 / 예약 ─────────────────────────
function actTalk_(req) {
  const text = mask_(String(req.text || req.question || '').trim());
  if (!text) throw new Error('말씀하신 내용이 비어 있습니다.');
  const history = (req.history || []).slice(-4).map(h => ({ 카일: String(h.q || '').slice(0, 300), Lobby: String(h.a || '').slice(0, 400) }));

  const plan = makePlan_(text, history);
  let intent = plan.의도 || '질문';
  if (intent === '브리핑') return Object.assign({ intent: '브리핑' }, buildBrief_());
  if (req.mode === 'question' && (intent === '기록' || intent === '예약')) intent = '질문';

  if (intent === '기록') {
    const r = actParse_({ text: text });
    return { intent: '기록', items: r.items, raw: r.raw };
  }
  if (intent === '예약' && plan.예약) {
    const t = normalizeTask_(plan.예약);
    t.다음실행 = nextRun_(t, new Date());
    return { intent: '예약', task: t, speech: describeTask_(t) + ' 이렇게 예약할까요?' };
  }
  return Object.assign({ intent: '질문' }, answer_(text, plan, history));
}

function makePlan_(text, history) {
  const cats = getCategories_().map(c => c.name);
  const docNames = getDocNames_();
  const sys = [
    '너는 카일님의 개인 비서 Lobby의 두뇌다. 카일님의 말을 보고 의도를 판단하고 조회계획을 JSON으로 만든다.',
    dateContext_(),
    '의도(하나):',
    '  기록 = 있었던 일·지출·앞으로의 일정·기억할 정보·특이점·아이디어를 남기려는 말 ("어제 오일 갈았어 8만원", "다음주 화요일 미라셀 미팅")',
    '  질문 = 기록·회사 문서·일반 지식에 대한 물음, 요약·정리·계획 요청 ("이번 주 일정 뭐야?", "CR-747 승인원 검사 항목 알려줘")',
    '  예약 = 정해진 시각에 Lobby가 알아서 하도록 맡기는 말 ("매주 월요일 8시에 이번 주 일정 정리해줘", "금요일 오후 5시에 이번 주 지출 알려줘")',
    '  브리핑 = 오늘 하루를 종합해 달라는 말 ("브리핑", "오늘 뭐 해야 돼?", "오늘 할 일·일정·날씨 알려 줘"). 특정 기간(이번 주 등)이나 특정 주제 질문은 브리핑이 아니라 질문.',
    '  대화 = 인사·잡담·감사',
    '  애매하면 질문. 과거형 서술·금액 보고는 기록.',
    '유형: ' + TYPES.join(', '),
    '분류: ' + cats.join(', '),
    '상태: ' + STATES.filter(s => s !== '삭제').join(', '),
    'Lobby가 읽을 수 있는 회사 문서 목록: ' + (docNames.length ? docNames.join(' / ') : '(아직 없음)'),
    '출처(하나): 기록(카일님이 말로 남긴 개인 기록) | 문서(승인원·작업표준서·검사기준·규격·사양·도면 등 회사 문서) | 둘다 | 없음(일반 상식·잡담).',
    '종류: 조회(목록), 통계(합계·횟수·평균), 최근(가장 최근 이력), 요약(기간 회고), 계획(제안), 정보(사실 질문)',
    '규칙:',
    '- 최근대화를 보고 "그거", "아까 그 문서" 같은 말을 해석한다.',
    '- 기간은 대상일 기준. "이번 주"=이번 주 월~일, "이번 달"=1일~말일, "올해"=1/1~12/31, "최근"=지난 30일. 기간 언급이 없고 최근·정보 질문이면 기간 null(전체).',
    '- 검색어는 기록의 제목·내용·태그·인물·장소에서 찾을 핵심 단어(동의어 포함).',
    '- 문서검색어는 문서 본문에서 찾을 핵심어 최대 8개: 모델명·부품명·검사항목·규격값 단어, 한글/영문 표기와 동의어 포함(예: ["CR-747","CR747","외관","치수","공차"]).',
    '- 문서파일은 카일님이 특정 문서를 지목하면 목록에서 그 파일명을 그대로 넣고, 아니면 [].',
    '- 분류·유형은 확실할 때만 넣는다. 계산: 합계|횟수|평균|없음. 그룹: 월|분류|유형|없음.',
    '- 의도가 예약이면 예약을 채운다: 이름(10자 안팎), 반복(매일|매주|매월|한번), 요일("월,수" 형식, 매주일 때), 날짜(매월이면 일자 숫자, 한번이면 yyyy-MM-dd), 시각(HH:mm 24시간), 요청(그 시각에 Lobby가 스스로 답할 질문 문장). 아니면 예약은 null.',
    '반드시 JSON만 출력:',
    '{"의도":"질문","출처":"기록","종류":"","기간":{"시작":"","끝":""},"유형":[],"분류":[],"상태":[],"검색어":[],"문서검색어":[],"문서파일":[],"계산":"없음","그룹":"없음","정렬":"최신","개수":30,"예약":null}',
  ].join('\n');
  const user = JSON.stringify({ 최근대화: history || [], 말씀: text });
  const plan = extractJson_(callClaude_(sys, user, 700));
  plan.의도 = ['기록', '질문', '예약', '대화', '브리핑'].indexOf(plan.의도) >= 0 ? plan.의도 : '질문';
  plan.출처 = ['기록', '문서', '둘다', '없음'].indexOf(plan.출처) >= 0 ? plan.출처 : '기록';
  if (plan.의도 === '대화' || plan.의도 === '브리핑') plan.출처 = '없음';
  return plan;
}

function answer_(q, plan, history) {
  const t0 = Date.now();
  const src = plan.출처 || '기록';
  const useRec = src === '기록' || src === '둘다';
  const useDoc = src === '문서' || src === '둘다';
  const result = useRec ? runPlan_(plan) : { rows: [], aiRows: [], stats: null };
  const kws = (plan.문서검색어 && plan.문서검색어.length) ? plan.문서검색어 : (plan.검색어 || []);
  const docs = useDoc ? searchDocs_(kws, plan.문서파일 || [], q) : [];

  const sys = [
    '너는 카일님의 개인 비서 Lobby다. 아래 자료만 근거로 답한다: [조회결과](카일님 기록), [문서발췌](회사 문서), [프로필].',
    dateContext_(),
    '규칙:',
    '- [조회결과].통계.일치기록있음이 true이면 기록이 있는 것이다. 절대 "기록이 없다"고 하지 말고 건수·날짜를 근거로 답한다. 조회방식에 "풀어서"가 있으면 조건을 완화해 찾은 것이므로 기록의 제목·내용을 직접 읽고 질문과 관련 있는 것만 세어 답한다(예: 루틴운동=운동·헬스·러닝·스트레칭 등 같은 뜻의 기록).',
    '- 참고기록_검색어불일치는 검색어와 글자는 달라도 같은 뜻일 수 있는 기록이다(기간 밖 기록 포함). 횟수·개수 질문이면 이 목록도 읽고 질문과 같은 활동이면 포함해 직접 센 뒤, 어떤 기록들을 셌는지 상세에 날짜와 함께 적는다.',
    '- 기록·문서에 없는 내용은 지어내지 않는다. 일치기록있음이 false일 때만 기록이 없다고 하고, 그때도 전체기록수와 함께 "기록 N건 중 관련 기록을 찾지 못했다"고 말하며 "해당 기록이 없습니다"라고 말하고 지금 기록할지 묻는다.',
    '- 문서발췌에 답이 없으면 "등록된 문서에서 찾지 못했습니다"라고 말하고, 어떤 문서를 Lobby 문서 폴더에 넣으면 되는지 한 줄로 제안한다.',
    '- 출처가 없음(인사·잡담·일반 상식)이면 알고 있는 지식으로 짧고 따뜻하게 답한다.',
    '- 숫자(합계·건수·평균)는 [조회결과].통계 값을 그대로 쓴다. 직접 다시 계산하지 않는다(단, 조회방식에 "풀어서"가 있으면 기록을 직접 읽고 관련 건만 세어 건수를 말한다).',
    '- 규격·치수·공차·검사기준·수량 같은 문서 수치는 단위까지 원문 그대로 옮긴다. 추정·반올림 금지.',
    '- 최근대화를 참고해 앞 질문과 이어지게 답한다.',
    '- 음성: 존댓말, 1~3문장, 첫 문장에 결론. 금액은 "48만 2천 원"처럼 읽기 쉽게. 문서를 인용하면 "○○ 승인원에 따르면"처럼 문서명만 짧게. 목록이 4건 이상이면 3건까지만 말하고 "나머지는 화면에 정리해 두었습니다".',
    '- 상세: 화면용. 줄바꿈으로 구분한 짧은 줄들. 목록은 "• "로 시작. 금액은 482,000원 형식. 문서 내용 줄 끝에는 (문서명 · 위치)를 붙인다.',
    '- 근거ID: 답변에 쓴 기록 ID 배열(최대 10개). 근거문서: 답변에 쓴 문서발췌 번호 배열(예: ["D1","D3"]).',
    '반드시 JSON만 출력: {"음성":"","상세":"","근거ID":[],"근거문서":[]}',
  ].join('\n');
  const payload = {
    질문: q, 최근대화: history || [], 조회계획: plan,
    조회결과: useRec ? { 통계: result.stats, 기록: result.aiRows, 참고기록_검색어불일치: result.extra } : '(기록은 조회하지 않음)',
    문서발췌: useDoc ? (docs.length ? docs.map(d => ({ 번호: d.key, 문서: d.파일명, 위치: d.위치, 내용: d.본문 })) : '(관련 문서 조각을 찾지 못함)') : '(문서는 조회하지 않음)',
    프로필: getProfile_(),
  };
  const ans = extractJson_(callClaude_(sys, JSON.stringify(payload), 1800));

  const evid = (ans.근거ID || []).map(String);
  const evidence = result.rows.filter(r => evid.indexOf(r.ID) >= 0).slice(0, 10);
  const dkeys = (ans.근거문서 || []).map(String);
  const docEvidence = docs.filter(d => dkeys.indexOf(d.key) >= 0)
    .map(d => ({ 파일명: d.파일명, 위치: d.위치, 링크: d.링크, 발췌: d.본문.replace(/\s+/g, ' ').slice(0, 180) }));

  sheet_(SH.LOG).appendRow([fmt_(new Date(), 'yyyy-MM-dd HH:mm'), q, JSON.stringify(plan), ans.음성 || '',
    '기록 ' + (result.stats ? result.stats.건수 : 0) + ' / 문서 ' + docs.length + ' / ' + Math.round((Date.now() - t0) / 100) / 10 + '초']);

  return { speech: ans.음성 || '', detail: ans.상세 || '', evidence: evidence, docEvidence: docEvidence, stats: result.stats, plan: plan };
}

function runPlan_(plan) {
  const all = getRecords_().filter(r => r.상태 !== '삭제');
  const p = plan || {};
  const from = p.기간 && p.기간.시작, to = p.기간 && p.기간.끝;
  const squash = t => String(t || '').toLowerCase().replace(/[\s·/_\-]+/g, '');
  const kws = (p.검색어 || []).map(squash).filter(Boolean);
  const has = (arr, v) => !(arr && arr.length) || arr.indexOf(v) >= 0;
  const byPeriod = r => (!from || dayOf_(r) >= from) && (!to || dayOf_(r) <= to);
  const byKw = r => {
    if (!kws.length) return true;
    const hay = squash([r.제목, r.내용, r.태그, r.인물, r.장소, r.분류, r.원문].join(' '));
    return kws.some(k => hay.indexOf(k) >= 0);
  };
  // 조건을 엄격한 순서대로 시도하고, 0건이면 조금씩 풀어서 다시 찾는다 (AI가 짠 계획이 어긋나도 기록을 놓치지 않게)
  const tries = [
    ['', r => byPeriod(r) && has(p.유형, r.유형) && has(p.분류, r.분류) && has(p.상태, r.상태) && byKw(r)],
    ['유형·분류·상태 조건을 풀어서 찾음', r => byPeriod(r) && byKw(r)],
    ['기간 조건을 풀어서 찾음(전체 기간)', r => byKw(r)],
  ];
  let rows = [], relaxed = '';
  for (let i = 0; i < tries.length; i++) {
    rows = all.filter(tries[i][1]);
    if (rows.length) { relaxed = tries[i][0]; break; }
  }
  const matched = rows.length > 0;
  if (!matched) { relaxed = '일치하는 기록 없음 — 최근 기록을 참고용으로 제공'; rows = all.filter(byPeriod); if (!rows.length) rows = all; }
  const asc = p.정렬 === '오래된';
  rows.sort((a, b) => (dayOf_(a) + a.대상시각).localeCompare(dayOf_(b) + b.대상시각) * (asc ? 1 : -1));

  const money = rows.map(r => r.금액).filter(v => typeof v === 'number');
  const sum = money.reduce((s, v) => s + v, 0);
  const stats = {
    건수: rows.length, 금액건수: money.length, 합계: sum,
    평균: money.length ? Math.round(sum / money.length) : 0,
    기간: { 시작: from || '', 끝: to || '' },
    조회방식: relaxed || '계획대로 정확히 일치', 일치기록있음: matched, 전체기록수: all.length,
  };
  const g = p.그룹;
  if (g && g !== '없음') {
    const key = r => g === '월' ? dayOf_(r).slice(0, 7) : (g === '분류' ? r.분류 : r.유형);
    const groups = {};
    rows.forEach(r => {
      const k = key(r) || '(없음)';
      groups[k] = groups[k] || { 건수: 0, 합계: 0 };
      groups[k].건수++;
      if (typeof r.금액 === 'number') groups[k].합계 += r.금액;
    });
    stats.그룹 = groups;
  }

  const wide = relaxed || p.종류 === '통계' || p.계산 === '횟수';
  const limit = wide ? CONFIG.MAX_ROWS_TO_AI : Math.min(Number(p.개수) || CONFIG.MAX_ROWS_TO_AI, CONFIG.MAX_ROWS_TO_AI);
  const aiRows = rows.slice(0, limit).map(r => ({
    ID: r.ID, 날짜: dayOf_(r), 시각: r.대상시각, 유형: r.유형, 분류: r.분류,
    제목: r.제목, 내용: r.내용, 금액: r.금액, 인물: r.인물, 장소: r.장소, 상태: r.상태,
  }));
  // 검색어에 안 걸렸지만 동의어일 수 있는 기록(예: 루틴운동 ↔ 러닝·헬스)을 AI가 직접 판단하도록 최근 기록을 함께 넘긴다
  let extra = [];
  if (kws.length && matched) {
    const inRows = {}; rows.forEach(r => inRows[r.ID] = 1);
    extra = all.filter(r => !inRows[r.ID])
      .sort((a, b) => (dayOf_(b) + b.대상시각).localeCompare(dayOf_(a) + a.대상시각)).slice(0, 40)
      .map(r => ({ ID: r.ID, 날짜: dayOf_(r), 유형: r.유형, 분류: r.분류, 제목: r.제목, 내용: String(r.내용).slice(0, 60), 상태: r.상태 }));
  }
  return { rows: rows, aiRows: aiRows, stats: stats, extra: extra };
}

// ───────────────────────── 회사 문서: 폴더 · 읽기(색인) · 검색 ─────────────────────────
function getDocsFolder_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('DOCS_FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* 새로 만듦 */ } }
  const it = DriveApp.getRootFolder().getFoldersByName(CONFIG.DOCS_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CONFIG.DOCS_FOLDER_NAME);
  p.setProperty('DOCS_FOLDER_ID', folder.getId());
  return folder;
}

function listFilesDeep_(folder, path, out) {
  const files = folder.getFiles();
  while (files.hasNext()) out.push({ file: files.next(), path: path });
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const s = subs.next();
    if (s.getName().charAt(0) === '_') continue;   // "_"로 시작하는 폴더는 건너뜀
    listFilesDeep_(s, path ? path + '/' + s.getName() : s.getName(), out);
  }
  return out;
}

/** 1시간마다 자동 실행: 문서 폴더의 새 파일·바뀐 파일을 읽어 둔다 */
function indexDocs() { return indexDocs_(CONFIG.INDEX_BUDGET_MS); }

function indexDocs_(budgetMs) {
  const props = PropertiesService.getScriptProperties();
  const busy = Number(props.getProperty('INDEX_BUSY') || 0);
  if (Date.now() - busy < 6 * 60 * 1000) return { busy: true, done: 0, pending: 0, errors: 0, removed: 0 };
  props.setProperty('INDEX_BUSY', String(Date.now()));
  const started = Date.now();
  try {
    const dsh = sheet_(SH.DOCS), csh = sheet_(SH.CHUNKS);
    const dn = dsh.getLastRow() - 1;
    const drows = dn > 0 ? dsh.getRange(2, 1, dn, DOC_HEADERS.length).getValues() : [];
    const idx = {};
    drows.forEach((r, i) => { idx[String(r[0])] = { row: i + 2, mod: String(r[3]), status: String(r[6]) }; });

    const list = listFilesDeep_(getDocsFolder_(), '', []);
    const seen = {};
    let done = 0, pending = 0, errors = 0;
    list.forEach(item => {
      const f = item.file, id = f.getId();
      seen[id] = true;
      const mod = fmt_(f.getLastUpdated(), 'yyyy-MM-dd HH:mm:ss');
      const cur = idx[id];
      if (cur && cur.mod === mod) return;                       // 바뀌지 않음
      if (Date.now() - started > budgetMs) { pending++; return; } // 다음 차례에

      const kind = kindOf_(f);
      let segs = [], status = '완료';
      try {
        if (kind.indexOf('미지원') === 0) status = kind;
        else { segs = extractSegments_(f, kind); if (!segs.some(s => s.text.trim())) status = '글자 없음'; }
      } catch (e) { status = '실패: ' + String(e && e.message || e).slice(0, 80); }

      removeChunks_(csh, id);
      const name = item.path ? item.path + '/' + f.getName() : f.getName();
      const chunks = chunkSegments_(segs);
      if (chunks.length) {
        csh.getRange(csh.getLastRow() + 1, 1, chunks.length, CHUNK_HEADERS.length)
          .setValues(chunks.map((c, i) => [id, name, i + 1, c.loc, c.text]));
      }
      const row = [id, name, kind.indexOf('미지원') === 0 ? '미지원' : kind, mod, chunks.length,
        fmt_(new Date(), 'yyyy-MM-dd HH:mm'), status, f.getUrl()];
      if (cur) dsh.getRange(cur.row, 1, 1, row.length).setValues([row]);
      else dsh.appendRow(row);
      if (status === '완료') done++; else errors++;
    });

    // 폴더에서 빠진 파일 정리
    const gone = Object.keys(idx).filter(id => !seen[id]);
    gone.forEach(id => removeChunks_(csh, id));
    gone.map(id => idx[id].row).sort((a, b) => b - a).forEach(r => dsh.deleteRow(r));
    return { busy: false, done: done, pending: pending, errors: errors, removed: gone.length };
  } finally {
    props.deleteProperty('INDEX_BUSY');
  }
}

function kindOf_(f) {
  const m = f.getMimeType(), n = f.getName().toLowerCase();
  if (m === MimeType.GOOGLE_DOCS) return '구글문서';
  if (m === MimeType.GOOGLE_SHEETS) return '구글시트';
  if (m === MimeType.GOOGLE_SLIDES) return '구글슬라이드';
  if (m === MimeType.PDF || /\.pdf$/.test(n)) return 'PDF';
  if (/wordprocessingml|msword/.test(m) || /\.docx?$/.test(n)) return '워드';
  if (/spreadsheetml|ms-excel/.test(m) || /\.xlsx?$/.test(n)) return '엑셀';
  if (/presentationml|ms-powerpoint/.test(m) || /\.pptx?$/.test(n)) return '파워포인트';
  if (/^image\/(jpeg|png|gif|bmp|webp)/.test(m)) return '이미지';
  if (/^text\//.test(m) || /\.(txt|csv|md)$/.test(n)) return '텍스트';
  if (/\.hwpx?$/.test(n) || /hwp/.test(m)) return '미지원(한글 HWP는 PDF로 저장해 넣어 주세요)';
  return '미지원(' + (n.split('.').pop() || m) + ')';
}

/** 파일 → [{loc, text}] 조각 전 단계 */
function extractSegments_(f, kind) {
  const id = f.getId();
  switch (kind) {
    case '구글문서': return [{ loc: '', text: DocumentApp.openById(id).getBody().getText() }];
    case '구글시트': return sheetSegments_(SpreadsheetApp.openById(id));
    case '구글슬라이드': return slideSegments_(SlidesApp.openById(id));
    case '텍스트': return [{ loc: '', text: f.getBlob().getDataAsString('UTF-8') }];
    case '워드': return withConverted_(f, MimeType.GOOGLE_DOCS, tid => [{ loc: '', text: DocumentApp.openById(tid).getBody().getText() }]);
    case '엑셀': return withConverted_(f, MimeType.GOOGLE_SHEETS, tid => sheetSegments_(SpreadsheetApp.openById(tid)));
    case '파워포인트': return withConverted_(f, MimeType.GOOGLE_SLIDES, tid => slideSegments_(SlidesApp.openById(tid)));
    case '이미지': return withConverted_(f, MimeType.GOOGLE_DOCS, tid => [{ loc: '이미지 글자', text: DocumentApp.openById(tid).getBody().getText() }]);
    case 'PDF': {
      let segs = [];
      try { segs = withConverted_(f, MimeType.GOOGLE_DOCS, tid => [{ loc: '', text: DocumentApp.openById(tid).getBody().getText() }]); }
      catch (e) { segs = []; }
      const len = segs.reduce((s, x) => s + x.text.replace(/\s/g, '').length, 0);
      if (len >= 200) return segs;
      return pdfSegmentsByClaude_(f);   // 스캔 PDF·도면 등 글자를 못 뽑은 경우
    }
  }
  return [];
}

/** 드라이브에서 구글 형식으로 변환한 임시 사본을 만들어 읽고 곧바로 휴지통으로 */
function withConverted_(f, targetMime, reader) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + f.getId() + '/copy?ocrLanguage=ko&supportsAllDrives=true&fields=id';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ name: '_lobby_임시_' + f.getName(), mimeType: targetMime, parents: ['root'] }),
  });
  if (res.getResponseCode() !== 200) throw new Error('변환 실패(' + res.getResponseCode() + ')');
  const tid = JSON.parse(res.getContentText()).id;
  try { return reader(tid); }
  finally { try { DriveApp.getFileById(tid).setTrashed(true); } catch (e) { /* 무시 */ } }
}

function sheetSegments_(ss) {
  return ss.getSheets().map(s => {
    const v = s.getDataRange().getDisplayValues().slice(0, 3000);
    const lines = v.map(row => {
      let r = row.slice(); while (r.length && String(r[r.length - 1]).trim() === '') r.pop();
      return r.join(' | ');
    }).filter(l => l.replace(/[\s|]/g, ''));
    return { loc: '시트 ' + s.getName(), text: lines.join('\n') };
  }).filter(s => s.text);
}

function slideSegments_(pres) {
  return pres.getSlides().map((sl, i) => {
    const t = [];
    sl.getShapes().forEach(sh => { try { const s = sh.getText().asString().trim(); if (s) t.push(s); } catch (e) { /* 글상자 아님 */ } });
    sl.getTables().forEach(tb => {
      for (let r = 0; r < tb.getNumRows(); r++) {
        const cells = [];
        for (let c = 0; c < tb.getNumColumns(); c++) { try { cells.push(tb.getCell(r, c).getText().asString().trim()); } catch (e) { cells.push(''); } }
        t.push(cells.join(' | '));
      }
    });
    return { loc: '슬라이드 ' + (i + 1), text: t.join('\n') };
  }).filter(s => s.text);
}

function pdfSegmentsByClaude_(f) {
  const bytes = f.getBlob().getBytes();
  if (bytes.length > CONFIG.PDF_AI_MAX_MB * 1024 * 1024) throw new Error('PDF가 ' + CONFIG.PDF_AI_MAX_MB + 'MB를 넘어 읽지 못했습니다');
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(bytes) } },
    { type: 'text', text: '이 PDF의 글자를 빠짐없이 옮겨 적어라. 각 페이지 시작에 [p.번호]를 붙인다. 표는 한 행을 "칸 | 칸 | 칸" 한 줄로 적는다. 도면의 치수·공차·주석·표제란도 적는다. 요약·설명 없이 원문만 출력.' },
  ];
  const txt = callClaude_('너는 문서 전사 도구다. 원문을 정확히 옮겨 적는다.', content, 8000);
  const parts = txt.split(/\[p\.(\d+)\]/);
  const segs = [];
  if (parts[0].trim()) segs.push({ loc: '', text: parts[0] });
  for (let i = 1; i < parts.length; i += 2) segs.push({ loc: 'p.' + parts[i], text: parts[i + 1] || '' });
  return segs;
}

function chunkSegments_(segs) {
  const out = [], size = CONFIG.CHUNK_SIZE, ov = CONFIG.CHUNK_OVERLAP;
  segs.forEach(sg => {
    const text = String(sg.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return;
    if (text.length <= size) { out.push({ loc: sg.loc, text: text }); return; }
    let pos = 0, part = 1;
    while (pos < text.length) {
      let end = Math.min(text.length, pos + size);
      if (end < text.length) {
        const nl = text.lastIndexOf('\n', end);
        if (nl > pos + size * 0.6) end = nl;
      }
      out.push({ loc: (sg.loc ? sg.loc + ' · ' : '') + '구간 ' + part, text: text.slice(pos, end).trim() });
      if (end >= text.length) break;
      pos = Math.max(end - ov, pos + 1); part++;
    }
  });
  return out.map(c => ({ loc: c.loc, text: c.text.slice(0, 45000) }));
}

function removeChunks_(csh, fileId) {
  const n = csh.getLastRow() - 1;
  if (n < 1) return;
  const rows = csh.getRange(2, 1, n, 1).createTextFinder(String(fileId)).matchEntireCell(true).findAll()
    .map(r => r.getRow()).sort((a, b) => a - b);
  if (!rows.length) return;
  const groups = [];
  rows.forEach(r => { const g = groups[groups.length - 1]; if (g && r === g[0] + g[1]) g[1]++; else groups.push([r, 1]); });
  groups.reverse().forEach(g => csh.deleteRows(g[0], g[1]));
}

function getDocNames_() {
  const sh = sheet_(SH.DOCS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 2, n, 1).getValues().map(r => String(r[0])).filter(Boolean).slice(0, 120);
}

/** 문서 조각 검색: 키워드가 많이 맞는 조각을 골라 Claude에게 넘긴다 */
function searchDocs_(keywords, files, q) {
  const sh = sheet_(SH.CHUNKS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  let kws = (keywords || []).map(k => String(k).trim()).filter(k => k.length >= 2);
  if (!kws.length) kws = String(q).split(/[\s,.?!]+/).filter(k => k.length >= 2).slice(0, 6);
  kws = kws.filter((k, i) => kws.indexOf(k) === i).slice(0, 6);       // 검색어가 많을수록 오래 걸려 6개까지만

  const names = sh.getRange(2, 2, n, 1).getValues().map(r => String(r[0]));
  const want = (files || []).map(String).filter(Boolean);
  const fileOk = row => !want.length || want.some(w => names[row - 2].indexOf(w) >= 0 || w.indexOf(names[row - 2]) >= 0);

  const body = sh.getRange(2, 5, n, 1);
  const score = {};
  kws.forEach(k => {
    const hits = body.createTextFinder(k).matchCase(false).findAll();
    if (!hits.length) return;
    const w = 1 / Math.log(2 + hits.length / 5);      // 흔한 단어는 가중치를 낮춤
    hits.forEach(h => { const r = h.getRow(); score[r] = (score[r] || 0) + w; });
    names.forEach((nm, i) => { if (nm.toLowerCase().indexOf(k.toLowerCase()) >= 0 && score[i + 2]) score[i + 2] += 0.5; });
  });
  let rows = Object.keys(score).map(Number).filter(fileOk).sort((a, b) => score[b] - score[a]);
  if (!rows.length && want.length) {                  // 지목한 문서가 있으면 앞부분이라도
    rows = names.map((nm, i) => i + 2).filter(fileOk).slice(0, CONFIG.MAX_DOC_CHUNKS_TO_AI);
  }
  const docsIdx = docLinks_();
  return rows.slice(0, CONFIG.MAX_DOC_CHUNKS_TO_AI).map((r, i) => {
    const v = sh.getRange(r, 1, 1, CHUNK_HEADERS.length).getValues()[0];
    return { key: 'D' + (i + 1), 파일ID: String(v[0]), 파일명: String(v[1]), 조각: v[2], 위치: String(v[3] || ''),
      본문: String(v[4]).slice(0, 2400), 링크: docsIdx[String(v[0])] || '' };
  });
}

function docLinks_() {
  const sh = sheet_(SH.DOCS);
  const n = sh.getLastRow() - 1;
  const o = {};
  if (n > 0) sh.getRange(2, 1, n, DOC_HEADERS.length).getValues().forEach(r => { o[String(r[0])] = String(r[7]); });
  return o;
}

function actDocs_() {
  const sh = sheet_(SH.DOCS);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, DOC_HEADERS.length).getValues().map(r => ({
    파일ID: String(r[0]), 파일명: String(r[1]), 형식: String(r[2]), 수정일시: cellStr_(r[3]),
    조각수: Number(r[4]) || 0, 읽은일시: cellStr_(r[5]), 상태: String(r[6]), 링크: String(r[7]),
  })) : [];
  rows.sort((a, b) => a.파일명.localeCompare(b.파일명));
  return { docs: rows, folderUrl: getDocsFolder_().getUrl(), folderName: CONFIG.DOCS_FOLDER_NAME };
}

function actReindex_() {
  const r = indexDocs_(40000);   // 앱에서 누르면 40초만 읽고, 남은 건 자동 실행이 이어서
  return Object.assign(r, actDocs_());
}

// ───────────────────────── 할 일 · 아침 브리핑 ─────────────────────────
/** 할 일 = 유형 '할일' + 상태 '예정'. 대상일은 기한(없으면 빈칸). 완료는 상태를 '완료'로 바꾸는 것(변경이력에 남음) */
function todoGroups_(all, today) {
  const open = all.filter(r => r.유형 === '할일' && r.상태 === '예정')
    .sort((a, b) => (a.대상일 || '9999').localeCompare(b.대상일 || '9999') || String(a.ID).localeCompare(String(b.ID)));
  return {
    late: open.filter(r => r.대상일 && r.대상일 < today),
    due: open.filter(r => r.대상일 === today),
    later: open.filter(r => !r.대상일 || r.대상일 > today),
  };
}
const todoPick_ = r => ({ ID: r.ID, 제목: r.제목, 기한: r.대상일, 분류: r.분류, 내용: r.내용 });

function actTodos_() {
  const g = todoGroups_(getRecords_().filter(r => r.상태 !== '삭제'), fmt_(new Date(), 'yyyy-MM-dd'));
  return { late: g.late.map(todoPick_), due: g.due.map(todoPick_), later: g.later.slice(0, 30).map(todoPick_) };
}

function actBrief_() { return { brief: buildBrief_() }; }

const WX_KO = { 0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '안개', 51: '이슬비', 53: '이슬비', 55: '이슬비',
  56: '어는 비', 57: '어는 비', 61: '비', 63: '비', 65: '강한 비', 66: '어는 비', 67: '어는 비', 71: '눈', 73: '눈', 75: '강한 눈', 77: '싸락눈',
  80: '소나기', 81: '소나기', 82: '강한 소나기', 85: '눈 소나기', 86: '눈 소나기', 95: '뇌우', 96: '뇌우', 99: '뇌우' };

function hourWord_(h) { return h === 0 ? '밤 12시' : h < 12 ? '오전 ' + h + '시' : h === 12 ? '낮 12시' : '오후 ' + (h - 12) + '시'; }
function timeWord_(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); if (!m) return '';
  return hourWord_(Number(m[1])) + (m[2] !== '00' ? ' ' + Number(m[2]) + '분' : '');
}

/** 무료 날씨(Open-Meteo). 실패하면 null — 브리핑은 날씨 없이도 나간다 */
function getWeather_() {
  const w = CONFIG.WEATHER;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.lat + '&longitude=' + w.lon +
      '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&hourly=precipitation_probability&timezone=Asia%2FSeoul&forecast_days=1';
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const nowH = Number(fmt_(new Date(), 'H'));
    let rainHour = null, rainP = 0;
    (j.hourly.time || []).forEach((t, i) => {
      const h = Number(String(t).slice(11, 13)), p = j.hourly.precipitation_probability[i] || 0;
      if (h >= nowH && p >= 50 && rainHour === null) { rainHour = h; rainP = p; }
    });
    const maxP = j.daily.precipitation_probability_max[0] || 0;
    const rain = rainHour !== null ? hourWord_(rainHour) + '쯤 비 소식이 있습니다(' + rainP + '%)'
      : maxP >= 30 ? '비 올 확률은 최대 ' + maxP + '%입니다' : '비 소식은 없습니다';
    return { 지역: w.name, 기온: Math.round(j.current.temperature_2m), 날씨: WX_KO[j.current.weather_code] || '',
      최고: Math.round(j.daily.temperature_2m_max[0]), 최저: Math.round(j.daily.temperature_2m_min[0]), 비: rain };
  } catch (e) { return null; }
}

/** 오늘 브리핑: AI 없이 시트 기록과 날씨만으로 만든다(무료·빠름) */
function buildBrief_() {
  const now = new Date(), today = fmt_(now, 'yyyy-MM-dd'), h = Number(fmt_(now, 'H'));
  const all = getRecords_().filter(r => r.상태 !== '삭제');
  const g = todoGroups_(all, today);
  const schedule = all.filter(r => /일정/.test(r.유형) && r.상태 === '예정' && r.대상일 === today)
    .sort((a, b) => String(a.대상시각 || '99').localeCompare(String(b.대상시각 || '99')));
  const wx = getWeather_();
  const greet = h < 5 ? '늦은 밤입니다' : h < 11 ? '좋은 아침입니다' : h < 17 ? '안녕하세요' : h < 22 ? '좋은 저녁입니다' : '늦은 밤입니다';
  const label = dateLabel_(today);

  const say = [greet + ', 카일님. ' + label + '입니다.'];
  const lines = ['■ ' + label];
  if (wx) {
    say.push(wx.지역 + '은 지금 ' + wx.기온 + '도, ' + wx.날씨 + '. 최고 ' + wx.최고 + '도, 최저 ' + wx.최저 + '도이고 ' + wx.비 + '.');
    lines.push('■ 날씨 · ' + wx.지역, '• 지금 ' + wx.기온 + '° ' + wx.날씨 + ' (최고 ' + wx.최고 + '° / 최저 ' + wx.최저 + '°)', '• ' + wx.비);
  }
  const sch = r => (r.대상시각 ? timeWord_(r.대상시각) + ' ' : '') + r.제목;
  if (schedule.length) {
    say.push('오늘 일정은 ' + schedule.slice(0, 3).map(sch).join(', ') + (schedule.length > 3 ? ' 외 ' + (schedule.length - 3) + '건' : '') + '입니다.');
    lines.push('■ 오늘 일정', ...schedule.map(r => '• ' + (r.대상시각 ? r.대상시각 + ' ' : '') + r.제목));
  } else { say.push('오늘 잡힌 일정은 없습니다.'); }
  if (g.due.length) {
    say.push('오늘 할 일은 ' + g.due.slice(0, 3).map(r => r.제목).join(', ') + (g.due.length > 3 ? ' 외 ' + (g.due.length - 3) + '가지' : '') + '입니다.');
  } else { say.push('오늘까지 해야 할 일은 없습니다.'); }
  if (g.late.length) say.push('기한이 지난 일이 ' + g.late.length + '개 있습니다.');
  if (g.late.length || g.due.length || g.later.length) {
    lines.push('■ 할 일');
    g.late.forEach(r => lines.push('• [기한 지남 ' + r.대상일.slice(5) + '] ' + r.제목));
    g.due.forEach(r => lines.push('• [오늘까지] ' + r.제목));
    g.later.slice(0, 5).forEach(r => lines.push('• ' + (r.대상일 ? '[' + r.대상일.slice(5) + '까지] ' : '') + r.제목));
  }
  return { greet: greet, 오늘: today, 날짜: label, 날씨: wx, 일정: schedule.map(todoPick_Sch_),
    late: g.late.map(todoPick_), due: g.due.map(todoPick_), later: g.later.slice(0, 5).map(todoPick_),
    speech: say.join(' '), detail: lines.join('\n') };
}
const todoPick_Sch_ = r => ({ ID: r.ID, 제목: r.제목, 시각: r.대상시각 });

function testBrief() { const b = buildBrief_(); Logger.log(b.speech + '\n\n' + b.detail); }

// ───────────────────────── 보고서 · 예약 작업 ─────────────────────────
/** 15분마다 자동 실행: 시간이 된 예약(밤 10시 보고서 포함)을 수행 */
function runScheduler() {
  const now = new Date();
  const nowStr = fmt_(now, 'yyyy-MM-dd HH:mm');
  getTasks_().forEach(t => {
    if (t.활성 !== 'Y') return;
    if (!t.다음실행) { t.다음실행 = nextRun_(t, now); saveTaskRow_(t); return; }
    if (t.다음실행 > nowStr) return;
    try { runTask_(t); }
    catch (e) { saveReport_({ 종류: '오류', 제목: t.이름 + ' 실행 실패', 음성요약: '', 상세: String(e && e.message || e), 예약ID: t.ID }); }
    t.마지막실행 = nowStr;
    if (t.반복 === '한번') { t.활성 = 'N'; t.다음실행 = ''; }
    else t.다음실행 = nextRun_(t, new Date(now.getTime() + 60000));
    saveTaskRow_(t);
  });
}

function runTask_(t) {
  if (t.요청 === '__DAILY__') return buildDailyReport_(fmt_(new Date(), 'yyyy-MM-dd'));
  if (t.요청 === '__BRIEF__') {
    const b = buildBrief_();
    return saveReport_({ 종류: '브리핑', 제목: b.날짜 + ' 아침 브리핑', 음성요약: b.speech, 상세: b.detail, 예약ID: t.ID });
  }
  const plan = makePlan_(t.요청, []);
  plan.의도 = '질문';
  const a = answer_(t.요청, plan, []);
  return saveReport_({ 종류: '예약', 제목: t.이름, 음성요약: a.speech, 상세: a.detail, 예약ID: t.ID });
}

/** 오늘 하루 기록으로 저녁 보고서를 만든다 (편집기에서 testDailyReport로 바로 시험 가능) */
function buildDailyReport_(dateStr) {
  const all = getRecords_().filter(r => r.상태 !== '삭제');
  const today = all.filter(r => r.대상일 === dateStr || String(r.입력일시).slice(0, 10) === dateStr);
  const upcoming = all.filter(r => /일정/.test(r.유형) && r.상태 === '예정' && r.대상일 > dateStr && r.대상일 <= ymdAdd_(dateStr, 7))
    .sort((a, b) => (a.대상일 + a.대상시각).localeCompare(b.대상일 + b.대상시각));
  const spend = today.filter(r => r.유형 === '지출' && typeof r.금액 === 'number');
  const month = dateStr.slice(0, 7);
  const monthSpend = all.filter(r => r.유형 === '지출' && typeof r.금액 === 'number' && dayOf_(r).slice(0, 7) === month)
    .reduce((s, r) => s + r.금액, 0);
  const byType = {};
  today.forEach(r => { byType[r.유형] = (byType[r.유형] || 0) + 1; });
  const stats = { 기록건수: today.length, 유형별: byType, 오늘지출건수: spend.length,
    오늘지출합계: spend.reduce((s, r) => s + r.금액, 0), 이번달지출합계: monthSpend, 다가오는일정수: upcoming.length };
  const openTodos = todoGroups_(all, dateStr);
  const todoList = openTodos.late.concat(openTodos.due, openTodos.later).slice(0, 15).map(r => ({ 제목: r.제목, 기한: r.대상일 || '없음' }));
  stats.남은할일수 = openTodos.late.length + openTodos.due.length + openTodos.later.length;
  const title = dateLabel_(dateStr) + ' 하루 정리';

  if (!today.length && !upcoming.length && !stats.남은할일수) {
    return saveReport_({ 종류: '일일', 제목: title,
      음성요약: '카일님, 오늘은 남기신 기록이 없습니다. 편안한 밤 보내세요.',
      상세: '• 오늘 기록 0건\n• 7일 안의 예정 일정 없음' });
  }
  const pick = r => ({ ID: r.ID, 날짜: r.대상일, 시각: r.대상시각, 유형: r.유형, 분류: r.분류, 제목: r.제목, 내용: r.내용, 금액: r.금액, 인물: r.인물, 장소: r.장소 });
  const sys = [
    '너는 카일님의 개인 비서 Lobby다. 오늘 하루 기록으로 저녁 보고서를 쓴다.',
    '오늘: ' + dateLabel_(dateStr),
    '규칙:',
    '- 숫자는 [통계] 값을 그대로 쓴다. 기록에 없는 일은 지어내지 않는다.',
    '- 음성: 존댓말 3~4문장. "카일님, 오늘 하루 정리해 드립니다."로 시작하고, 가장 중요한 일 → 지출 → 내일 일정 순으로 짧게.',
    '- 상세: 아래 제목 순서로, 해당 내용이 없는 제목은 생략. 목록은 "• "로 시작. 금액은 12,000원 형식.',
    '  ■ 오늘 한 일 / ■ 지출 (오늘 합계, 이번 달 누적) / ■ 업무·특이점 / ■ 남은 할 일 ([남은할일] 기준, 기한 지난 것 먼저) / ■ 떠오른 아이디어 / ■ 다가오는 일정 (7일) / ■ Lobby의 한마디 (내일을 위한 짧은 제안 1줄)',
    '반드시 JSON만 출력: {"음성":"","상세":""}',
  ].join('\n');
  const payload = { 통계: stats, 오늘기록: today.map(pick), 다가오는일정: upcoming.slice(0, 15).map(pick), 남은할일: todoList };
  const ans = extractJson_(callClaude_(sys, JSON.stringify(payload), 1500));
  return saveReport_({ 종류: '일일', 제목: title, 음성요약: ans.음성 || '', 상세: ans.상세 || '' });
}

function testDailyReport() { const r = buildDailyReport_(fmt_(new Date(), 'yyyy-MM-dd')); Logger.log(r.음성요약 + '\n\n' + r.상세); }

function saveReport_(o) {
  const r = { ID: 'R' + fmt_(new Date(), 'yyyyMMddHHmmss') + Math.floor(Math.random() * 90 + 10),
    생성일시: fmt_(new Date(), 'yyyy-MM-dd HH:mm'), 종류: o.종류 || '일일', 제목: o.제목 || '',
    음성요약: o.음성요약 || '', 상세: o.상세 || '', 읽음: 'N', 예약ID: o.예약ID || '' };
  sheet_(SH.REPORT).appendRow(REPORT_HEADERS.map(h => r[h]));
  return r;
}

function getReports_(limit) {
  const sh = sheet_(SH.REPORT);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const take = Math.min(n, limit || 60);
  const v = sh.getRange(n + 2 - take, 1, take, REPORT_HEADERS.length).getValues();
  return v.reverse().map(r => REPORT_HEADERS.reduce((o, h, i) => (o[h] = cellStr_(r[i]), o), {}));
}

function actReports_() { return { reports: getReports_(60), tasks: getTasks_().map(stripRow_) }; }

function actReadReport_(req) {
  const sh = sheet_(SH.REPORT);
  const n = sh.getLastRow() - 1;
  if (n < 1) return {};
  const ids = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]));
  (req.ids || [req.id]).forEach(id => { const i = ids.indexOf(String(id)); if (i >= 0) sh.getRange(i + 2, 7).setValue('Y'); });
  return {};
}

function actDeleteReport_(req) {
  const sh = sheet_(SH.REPORT);
  const n = sh.getLastRow() - 1;
  if (n < 1) return {};
  const i = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])).indexOf(String(req.id));
  if (i >= 0) sh.deleteRow(i + 2);
  return { deleted: req.id };
}

function actRunDaily_() { return { report: buildDailyReport_(fmt_(new Date(), 'yyyy-MM-dd')) }; }

function actSaveTask_(req) {
  const t = normalizeTask_(req.task || {});
  if (!t.요청) throw new Error('예약할 요청 내용이 비어 있습니다.');
  if (t.반복 === '매주' && !t.요일) throw new Error('매주 반복은 요일을 골라 주세요.');
  if (t.반복 === '한번' && !/^\d{4}-\d{2}-\d{2}$/.test(t.날짜)) throw new Error('한 번 실행할 날짜를 골라 주세요.');
  const old = getTasks_().filter(x => x.ID === t.ID)[0];
  if (old && old.ID === DAILY_ID) t.요청 = '__DAILY__';
  if (!t.ID) t.ID = 'T' + fmt_(new Date(), 'yyyyMMddHHmmss');
  if (old) { t._row = old._row; t.마지막실행 = old.마지막실행; }
  t.다음실행 = t.활성 === 'Y' ? nextRun_(t, new Date()) : '';
  saveTaskRow_(t);
  return { task: stripRow_(t), tasks: getTasks_().map(stripRow_) };
}

function actDeleteTask_(req) {
  if (req.id === DAILY_ID) throw new Error('오늘의 보고서는 지울 수 없습니다. 끄기만 할 수 있습니다.');
  const t = getTasks_().filter(x => x.ID === req.id)[0];
  if (t) sheet_(SH.TASKS).deleteRow(t._row);
  return { tasks: getTasks_().map(stripRow_) };
}

function normalizeTask_(x) {
  const days = Array.isArray(x.요일) ? x.요일 : String(x.요일 || '').split(/[,\s·/]+/);
  const t = {
    ID: String(x.ID || ''), 이름: String(x.이름 || '').slice(0, 30) || '예약 작업',
    반복: REPEATS.indexOf(x.반복) >= 0 ? x.반복 : '매일',
    요일: days.map(d => String(d).trim().charAt(0)).filter(d => WEEKDAYS.indexOf(d) >= 0)
      .sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(','),
    날짜: String(x.날짜 == null ? '' : x.날짜).trim(), 시각: normTime_(x.시각) || '09:00',
    요청: String(x.요청 || '').trim(), 활성: x.활성 === 'N' || x.활성 === false ? 'N' : 'Y',
    마지막실행: String(x.마지막실행 || ''), 다음실행: String(x.다음실행 || ''),
  };
  if (t.반복 !== '매주') t.요일 = '';
  if (t.반복 === '매일') t.날짜 = '';
  return t;
}

function describeTask_(t) {
  const when = t.반복 === '매일' ? '매일' : t.반복 === '매주' ? '매주 ' + t.요일.replace(/,/g, '·') + '요일'
    : t.반복 === '매월' ? '매월 ' + t.날짜 + '일' : dateLabel_(t.날짜);
  const [h, m] = t.시각.split(':').map(Number);
  const time = (h < 12 ? '오전 ' : '오후 ') + ((h % 12) || 12) + '시' + (m ? ' ' + m + '분' : '');
  return when + ' ' + time + '에 "' + t.요청 + '"을(를) 수행합니다.';
}

function getTasks_() {
  const sh = sheet_(SH.TASKS);
  if (!sh) return [];
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, TASK_HEADERS.length).getValues().map((r, i) => {
    const o = TASK_HEADERS.reduce((a, h, j) => (a[h] = cellStr_(r[j], h), a), {});
    o._row = i + 2;
    return o;
  }).filter(t => t.ID);
}

function saveTaskRow_(t) {
  const sh = sheet_(SH.TASKS);
  const row = TASK_HEADERS.map(h => t[h] == null ? '' : String(t[h]));
  if (t._row) sh.getRange(t._row, 1, 1, row.length).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function stripRow_(t) { const o = Object.assign({}, t); delete o._row; return o; }

function nextRun_(t, from) {
  const nowStr = fmt_(from, 'yyyy-MM-dd HH:mm');
  const d0 = nowStr.slice(0, 10);
  const time = normTime_(t.시각) || '09:00';
  if (t.반복 === '한번') { const c = String(t.날짜) + ' ' + time; return c > nowStr ? c : ''; }
  const days = String(t.요일 || '').split(',').filter(Boolean);
  for (let i = 0; i < 400; i++) {
    const d = ymdAdd_(d0, i);
    let ok = t.반복 === '매일';
    if (t.반복 === '매주') ok = days.indexOf(weekdayOf_(d)) >= 0;
    if (t.반복 === '매월') { const want = Number(t.날짜) || 1; ok = Number(d.slice(8)) === Math.min(want, lastDom_(d)); }
    if (ok) { const c = d + ' ' + time; if (c > nowStr) return c; }
  }
  return '';
}

function normTime_(s) {
  const m = String(s || '').match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?/);
  if (!m) return '';
  let h = Math.min(23, Number(m[1]));
  const mi = Math.min(59, Number(m[2] || 0));
  if (h === 12 && /오전|새벽|밤/.test(String(s))) h = 0;          // "밤 12시"·"오전 12시"는 자정(00시)
  else if (h < 12 && (/오후|저녁/.test(String(s)) || (/밤/.test(String(s)) && h >= 6))) h += 12;   // "밤 1~5시"는 새벽이라 그대로 둔다
  return ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2);
}
function ymdAdd_(s, n) { const d = Utilities.parseDate(s + ' 12:00', CONFIG.TZ, 'yyyy-MM-dd HH:mm'); return fmt_(new Date(d.getTime() + n * 86400000), 'yyyy-MM-dd'); }
function weekdayOf_(s) { const d = Utilities.parseDate(s + ' 12:00', CONFIG.TZ, 'yyyy-MM-dd HH:mm'); return WEEKDAYS[Number(fmt_(d, 'u')) - 1]; }
function lastDom_(s) { return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0).getDate(); }
function dateLabel_(s) { return Number(s.slice(5, 7)) + '월 ' + Number(s.slice(8, 10)) + '일(' + weekdayOf_(s) + ')'; }

// ───────────────────────── 수정&삭제 탭 ─────────────────────────
function actList_(req) {
  const deleted = !!req.deleted;
  let rows = getRecords_().filter(r => deleted ? r.상태 === '삭제' : r.상태 !== '삭제');
  if (req.from || req.to) {
    const f = req.from || '0000-00-00', t = req.to || '9999-99-99';
    rows = rows.filter(r => {
      const d1 = dayOf_(r), d2 = String(r.입력일시).slice(0, 10);
      return (d1 >= f && d1 <= t) || (d2 >= f && d2 <= t);
    });
  }
  if (req.type) rows = rows.filter(r => r.유형 === req.type);
  if (req.q) {
    const k = String(req.q).toLowerCase();
    rows = rows.filter(r => [r.제목, r.내용, r.태그, r.인물, r.장소, r.원문, r.분류].join(' ').toLowerCase().indexOf(k) >= 0);
  }
  rows.sort((a, b) => String(b.입력일시 + b.ID).localeCompare(String(a.입력일시 + a.ID)));
  return { rows: rows.slice(0, 200), total: rows.length };
}

function actUpdate_(req) {
  const fields = req.fields || {};
  return withRow_(req.id, (sh, rowIdx, cur) => {
    const now = fmt_(new Date(), 'yyyy-MM-dd HH:mm');
    const hist = [];
    const next = cur.slice();
    EDITABLE.forEach(k => {
      if (!(k in fields)) return;
      let v = fields[k];
      if (k === '금액') v = toNum_(v) === null ? '' : toNum_(v);
      else if (k === '인물' || k === '태그') v = listStr_(v);
      else v = mask_(String(v == null ? '' : v));
      if (k === '유형' && TYPES.indexOf(v) < 0) return;
      if (k === '상태' && STATES.indexOf(v) < 0) return;
      const old = cellStr_(cur[COL[k]], k);
      if (String(old) !== String(v)) { next[COL[k]] = v; hist.push([now, req.id, k, old, v, '화면']); }
    });
    if (!hist.length) return { changed: 0 };
    next[COL['수정일시']] = now;
    sh.getRange(rowIdx, 1, 1, REC_HEADERS.length).setValues([next]);
    appendHistory_(hist);
    return { changed: hist.length, row: toObj_(next) };
  });
}

function actDelete_(req) {
  return withRow_(req.id, (sh, rowIdx, cur) => {
    const now = fmt_(new Date(), 'yyyy-MM-dd HH:mm');
    const old = cellStr_(cur[COL['상태']]);
    if (old === '삭제') return { already: true };
    sh.getRange(rowIdx, COL['상태'] + 1).setValue('삭제');
    sh.getRange(rowIdx, COL['삭제일시'] + 1).setValue(now);
    appendHistory_([[now, req.id, '상태', old, '삭제', '화면']]);
    return { deleted: req.id };
  });
}

function actRestore_(req) {
  return withRow_(req.id, (sh, rowIdx, cur) => {
    const now = fmt_(new Date(), 'yyyy-MM-dd HH:mm');
    const hs = sheet_(SH.HISTORY);
    const n = hs.getLastRow() - 1;
    let prev = '정상';
    if (n > 0) {
      const h = hs.getRange(2, 1, n, 6).getValues();
      for (let i = h.length - 1; i >= 0; i--) {
        if (String(h[i][1]) === String(req.id) && h[i][2] === '상태' && h[i][4] === '삭제') { prev = String(h[i][3]) || '정상'; break; }
      }
    }
    sh.getRange(rowIdx, COL['상태'] + 1).setValue(prev);
    sh.getRange(rowIdx, COL['삭제일시'] + 1).setValue('');
    appendHistory_([[now, req.id, '상태', '삭제', prev, '복구']]);
    return { restored: req.id, 상태: prev };
  });
}

function withRow_(id, fn) {
  if (!id) throw new Error('기록 ID가 없습니다.');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(SH.RECORD);
    const n = sh.getLastRow() - 1;
    if (n < 1) throw new Error('기록이 없습니다.');
    const ids = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]));
    const i = ids.indexOf(String(id));
    if (i < 0) throw new Error('해당 기록을 찾지 못했습니다: ' + id);
    const rowIdx = i + 2;
    const cur = sh.getRange(rowIdx, 1, 1, REC_HEADERS.length).getValues()[0];
    return fn(sh, rowIdx, cur);
  } finally {
    lock.releaseLock();
  }
}

function appendHistory_(rows) {
  const sh = sheet_(SH.HISTORY);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
}

/** 매일 새벽 4시: 삭제 후 30일 지난 기록을 휴지통 탭으로 옮김 */
function purgeTrash() {
  const sh = sheet_(SH.RECORD), tr = sheet_(SH.TRASH);
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const limit = fmt_(new Date(Date.now() - CONFIG.TRASH_DAYS * 86400000), 'yyyy-MM-dd HH:mm');
  const data = sh.getRange(2, 1, n, REC_HEADERS.length).getValues();
  const move = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const d = cellStr_(data[i][COL['삭제일시']]);
    if (data[i][COL['상태']] === '삭제' && d && d < limit) { move.push(data[i]); sh.deleteRow(i + 2); }
  }
  if (move.length) tr.getRange(tr.getLastRow() + 1, 1, move.length, REC_HEADERS.length).setValues(move.reverse());
}

// ───────────────────────── Claude 사용 요금(예상) ─────────────────────────
// Claude API가 응답마다 알려 주는 토큰 수에 단가를 곱해 "사용량" 탭에 날짜·모델별로 쌓는다.
// 실제 청구액(console.anthropic.com)과는 환율·단가 차이로 조금 다를 수 있는 "예상 금액"이다.
function costKrw_(model, inTok, outTok) {
  const prices = CONFIG.PRICE_PER_MTOK;
  const key = prices[model] ? model : Object.keys(prices).filter(k => String(model).indexOf(k) === 0)[0];
  const p = prices[key] || prices['claude-sonnet-4-5'];
  return (inTok * p[0] + outTok * p[1]) / 1e6 * CONFIG.KRW_PER_USD;
}

function recordUsage_(model, usage) {
  if (!usage) return;
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(5000); locked = true;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SH.USAGE) || ensureSheet_(ss, SH.USAGE, USAGE_HEADERS, ['A:B']);
    const day = fmt_(new Date(), 'yyyy-MM-dd');
    const inTok = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
    const outTok = Number(usage.output_tokens || 0);
    const n = sh.getLastRow() - 1;
    let row = -1, cur = [day, model, 0, 0, 0, 0];
    if (n > 0) {
      const keys = sh.getRange(2, 1, n, 2).getValues();
      for (let i = keys.length - 1; i >= 0; i--) {            // 오늘 행은 보통 맨 아래쪽에 있다
        if (cellStr_(keys[i][0], '날짜') === day && String(keys[i][1]) === model) { row = i + 2; break; }
      }
      if (row > 0) cur = sh.getRange(row, 1, 1, 6).getValues()[0];
    }
    const inAll = Number(cur[3]) + inTok, outAll = Number(cur[4]) + outTok;
    const next = [day, model, Number(cur[2]) + 1, inAll, outAll, Math.round(costKrw_(model, inAll, outAll))];
    if (row > 0) sh.getRange(row, 1, 1, 6).setValues([next]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setValues([next]);
  } catch (e) { /* 요금 기록이 실패해도 답변은 계속 */ }
  finally { if (locked) lock.releaseLock(); }
}

function usageSummary_() {
  try {
    const sh = sheet_(SH.USAGE);
    const o = { 오늘: 0, 이번달: 0, 누적: 0, 오늘호출: 0, 월예산: CONFIG.MONTH_BUDGET_KRW, 기준: '예상' };
    if (!sh) return o;
    const n = sh.getLastRow() - 1;
    if (n < 1) return o;
    const today = fmt_(new Date(), 'yyyy-MM-dd'), month = today.slice(0, 7);
    sh.getRange(2, 1, n, 6).getValues().forEach(r => {
      const d = cellStr_(r[0], '날짜'), c = Number(r[5]) || 0;
      o.누적 += c;
      if (d.slice(0, 7) === month) o.이번달 += c;
      if (d === today) { o.오늘 += c; o.오늘호출 += Number(r[2]) || 0; }
    });
    return o;
  } catch (e) { return null; }
}

// ───────────────────────── 공통 유틸 ─────────────────────────
function getRecords_() {
  const sh = sheet_(SH.RECORD);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, REC_HEADERS.length).getValues().filter(r => r[0]).map(toObj_);
}

function toObj_(r) {
  const o = {};
  REC_HEADERS.forEach((h, i) => { o[h] = h === '금액' ? toNum_(r[i]) : cellStr_(r[i], h); });
  return o;
}

function cellStr_(v, h) {
  if (v instanceof Date) {
    if (h === '대상시각' || h === '시각') return fmt_(v, 'HH:mm');
    if (h === '대상일' || h === '날짜') return fmt_(v, 'yyyy-MM-dd');
    return fmt_(v, 'yyyy-MM-dd HH:mm');
  }
  return v == null ? '' : String(v);
}

function dayOf_(r) { return r.대상일 || String(r.입력일시).slice(0, 10); }

function recent_(n) {
  return getRecords_().filter(r => r.상태 !== '삭제')
    .sort((a, b) => String(b.입력일시 + b.ID).localeCompare(String(a.입력일시 + a.ID))).slice(0, n);
}

function getCategories_() {
  const sh = sheet_(SH.CATEGORY);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 2).getValues().filter(r => r[0]).map(r => ({ name: String(r[0]).trim(), desc: String(r[1]) }));
}

function getProfile_() {
  const sh = sheet_(SH.PROFILE);
  const n = sh.getLastRow() - 1;
  if (n < 1) return {};
  const o = {};
  sh.getRange(2, 1, n, 2).getValues().forEach(r => { if (r[0]) o[String(r[0])] = cellStr_(r[1]); });
  return o;
}

function dateContext_() {
  const now = new Date();
  const u = Number(fmt_(now, 'u'));            // 1=월 … 7=일
  const monday = new Date(now.getTime() - (u - 1) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return '오늘: ' + fmt_(now, 'yyyy-MM-dd') + ' (' + WEEKDAYS[u - 1] + '요일), 현재 ' + fmt_(now, 'HH:mm') +
    '. 이번 주: ' + fmt_(monday, 'yyyy-MM-dd') + ' ~ ' + fmt_(sunday, 'yyyy-MM-dd') + ' (월~일).';
}

function fmt_(d, p) { return Utilities.formatDate(d, CONFIG.TZ, p); }

function toNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return String(v).replace(/[^\d]/g, '') === '' || !isFinite(n) ? null : Math.round(n);
}

function listStr_(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean).join(', ');
  return String(v || '').trim();
}

/** 카드번호·계좌번호처럼 보이는 긴 숫자열 가리기 */
function mask_(s) {
  return String(s)
    .replace(/\b(\d{4})[-\s]?(\d{4})[-\s]?(\d{4})[-\s]?(\d{4})\b/g, '$1-****-****-****')
    .replace(/\b\d{2,6}-\d{2,6}-\d{4,8}\b/g, m => m.slice(0, 3) + '***');
}

/** user는 문자열 또는 content 배열(PDF 등) */
function callClaude_(system, user, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('스크립트 속성에 ANTHROPIC_API_KEY가 없습니다.');
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CONFIG.MODEL, max_tokens: maxTokens || 1500, system: system,
      messages: [{ role: 'user', content: user }],
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error('Claude API 오류(' + code + '): ' + (body.error && body.error.message || ''));
  recordUsage_(CONFIG.MODEL, body.usage);
  return body.content.map(c => c.text || '').join('');
}

function extractJson_(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = m ? m[1] : String(text);
  const i = s.search(/[\[{]/);
  const j = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (i < 0 || j < i) throw new Error('AI 응답을 해석하지 못했습니다. 다시 말씀해 주세요.');
  return JSON.parse(s.slice(i, j + 1));
}
