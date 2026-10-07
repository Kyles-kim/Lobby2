// deno-lint-ignore-file no-explicit-any
/**
 * Lobby2 — 말로 기록하고, 말로 묻고, 올려 둔 문서를 읽고, 밤마다 보고하는 개인 비서
 * 백엔드: Supabase Edge Function (DB: Postgres, 파일: Storage "docs" 버킷)
 *
 * 필요한 비밀 값(Supabase 대시보드 > Edge Functions > Secrets)
 *  - ANTHROPIC_API_KEY : Claude API 키
 *  - APP_PIN           : 앱 접속 암호
 *  - CRON_SECRET       : 자동 실행(1분마다)이 서버를 부를 때 쓰는 암호 (supabase/cron.sql 참고)
 *  - LOBBY_MODEL       : (선택) 모델을 바꿀 때만
 *  - VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY : (선택) 휴대폰 알림 서명 키. 없으면 서버가 처음 한 번 만들어 app_keys 표에 보관한다
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { strFromU8, unzipSync } from "npm:fflate";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";

// ───────────────────────── 설정 ─────────────────────────
const CONFIG = {
  MODEL: Deno.env.get("LOBBY_MODEL") || "claude-sonnet-4-5",
  TRASH_DAYS: 30,               // 삭제 후 복구 가능 기간(일)
  LEARN_SCAN: 800,              // 입력 습관을 배울 때 살펴볼 최근 기록 수
  LEARN_EXAMPLES: 6,            // 새 입력 정리 시 참고용으로 보여 줄 비슷한 과거 기록 수
  KRW_PER_USD: 1400,            // 환율(원/달러). 사용 요금을 원화로 보여 줄 때 쓰는 값이라 대략 맞춰 두면 됩니다
  PRICE_PER_MTOK: {             // 모델별 [입력, 출력] 단가(달러 / 100만 토큰). 모델을 바꾸면 여기도 확인해 주세요
    "claude-sonnet-4-5": [3, 15], "claude-haiku-4-5": [1, 5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20],
  } as Record<string, number[]>,
  MONTH_BUDGET_KRW: 0,          // 월 예산(원). 0이면 끔. 정해 두면 80%·100%에서 화면의 금액 색이 바뀝니다
  MAX_ROWS_TO_AI: 150,          // 답변 작성 시 Claude에게 넘길 최대 기록 수
  WEATHER: { name: "서울", lat: 37.5665, lon: 126.978 },   // 브리핑 날씨 지역 (위도·경도를 바꾸면 다른 지역)
  CHUNK_SIZE: 1500,             // 문서를 나누는 조각 크기(글자)
  CHUNK_OVERLAP: 200,
  MAX_DOC_CHUNKS_TO_AI: 8,      // 답변에 넘길 문서 조각 수
  UPLOAD_MAX_MB: 50,            // 올릴 수 있는 파일 크기
  PDF_AI_MAX_MB: 20,            // 글자를 못 뽑은 PDF(스캔본·도면)를 Claude로 읽을 때 최대 크기
  IMAGE_MAX_MB: 5,              // 사진 글자 인식 최대 크기
  DOC_READ_CHARS: 4000,         // "읽어 주기"로 한 번에 읽어 주는 분량(글자)
  LINK_HOURS: 24,               // 문서 열기 링크가 유효한 시간
  BUCKET: "docs",
  ALARM_DEFAULT_MIN: 10,        // 일정·업무일정에 시각이 있으면 기본으로 몇 분 전에 알릴지 (앱 설정에서 바꿀 수 있음)
  ALARM_ALLDAY_TIME: "09:00",   // 시각 없는(종일) 일정에 알림을 켜면 이 시각을 기준으로 알린다
  ALARM_GRACE_MIN: 60,          // 이 시간(분) 넘게 지난 알림은 늦게라도 울리지 않고 버린다
  PUSH_CONTACT: "https://github.com/kyles-kim/Lobby2",   // 휴대폰 알림 서버(애플·구글)에 알려 주는 연락처
};
const BUILD = "2026-10-08 Lobby2 · Supabase · 일정 알림 · 도면·사진";

const TYPES = ["일상", "지출", "일정", "업무일정", "정보", "특이점", "아이디어", "할일"];
const STATES = ["정상", "예정", "완료", "취소", "삭제"];
const EDITABLE = ["대상일", "대상시각", "유형", "분류", "제목", "내용", "금액", "인물", "장소", "태그", "상태", "알림"];
const REPEATS = ["매일", "매주", "매월", "한번"];
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
const DAILY_ID = "DAILY";
const BRIEF_ID = "BRIEF";

// 화면이 쓰는 한글 이름 ↔ DB 칸 이름
const REC_MAP: [string, string][] = [["ID", "id"], ["입력일시", "created_at"], ["대상일", "target_date"], ["대상시각", "target_time"],
  ["유형", "type"], ["분류", "category"], ["제목", "title"], ["내용", "content"], ["금액", "amount"], ["인물", "people"],
  ["장소", "place"], ["태그", "tags"], ["상태", "status"], ["원문", "raw"], ["수정일시", "updated_at"], ["삭제일시", "deleted_at"],
  ["알림", "alarm"], ["알림시각", "alarm_at"]];
const REPORT_MAP: [string, string][] = [["ID", "id"], ["생성일시", "created_at"], ["종류", "kind"], ["제목", "title"],
  ["음성요약", "speech"], ["상세", "detail"], ["읽음", "is_read"], ["예약ID", "task_id"]];
const TASK_MAP: [string, string][] = [["ID", "id"], ["이름", "name"], ["반복", "repeat"], ["요일", "weekdays"], ["날짜", "date"],
  ["시각", "time"], ["요청", "request"], ["활성", "active"], ["마지막실행", "last_run"], ["다음실행", "next_run"]];
const toKo = (row: any, map: [string, string][]) => map.reduce((o: any, [k, c]) => (o[k] = row[c] ?? (k === "금액" ? null : ""), o), {});
const toDb = (obj: any, map: [string, string][]) => map.reduce((o: any, [k, c]) => { if (k in obj) o[c] = obj[k]; return o; }, {});
const COL = Object.fromEntries(REC_MAP);

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") || "missing" });

/** Supabase 응답에서 data만 꺼내고, 오류는 던진다 */
async function run<T = any>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error("DB 오류: " + (error.message || JSON.stringify(error)));
  return data;
}
/** 1,000줄씩 끊어 주는 API에서 끝까지 읽는다 */
async function fetchAll(make: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run<any[]>(make().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ───────────────────────── 한국 시간 ─────────────────────────
const z2 = (n: number) => String(n).padStart(2, "0");
function kst(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600000);
  const ymd = k.getUTCFullYear() + "-" + z2(k.getUTCMonth() + 1) + "-" + z2(k.getUTCDate());
  const hm = z2(k.getUTCHours()) + ":" + z2(k.getUTCMinutes());
  return { ymd, hm, sec: z2(k.getUTCSeconds()), hour: k.getUTCHours(), minute: k.getUTCMinutes(), wd: (k.getUTCDay() + 6) % 7 };   // wd: 0=월 … 6=일
}
const today = () => kst().ymd;
const nowStr = (d = new Date()) => { const p = kst(d); return p.ymd + " " + p.hm; };
function ymdAdd(s: string, n: number) { return new Date(Date.parse(s + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
function weekdayOf(s: string) { return WEEKDAYS[(new Date(s + "T12:00:00Z").getUTCDay() + 6) % 7]; }
function lastDom(s: string) { return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)).getUTCDate(); }
function dateLabel(s: string) { return Number(s.slice(5, 7)) + "월 " + Number(s.slice(8, 10)) + "일(" + weekdayOf(s) + ")"; }
function dateContext() {
  const p = kst();
  const monday = ymdAdd(p.ymd, -p.wd);
  return "오늘: " + p.ymd + " (" + WEEKDAYS[p.wd] + "요일), 현재 " + p.hm + ". 이번 주: " + monday + " ~ " + ymdAdd(monday, 6) + " (월~일).";
}

// ───────────────────────── 웹 요청 ─────────────────────────
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o: any) => new Response(JSON.stringify(o), { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const handlers: Record<string, (req: any) => Promise<any> | any> = {
  init: actInit, parse: actParse, save: actSave,
  ask: (r) => actTalk({ ...r, mode: "question" }), talk: actTalk,
  list: actList, update: actUpdate, delete: actDelete, restore: actRestore,
  docs: actDocs, uploadUrl: actUploadUrl, docMemo: actDocMemo, indexDoc: actIndexDoc, reindex: actReindex, deleteDoc: actDeleteDoc, readDoc: actReadDoc,
  reports: actReports, readReport: actReadReport, deleteReport: actDeleteReport, runDaily: actRunDaily,
  saveTask: actSaveTask, deleteTask: actDeleteTask,
  todos: actTodos, brief: actBrief, usage: () => ({}),
  alarms: actAlarms, alarmAck: actAlarmAck, pushKey: actPushKey, pushSub: actPushSub, pushUnsub: actPushUnsub, pushTest: actPushTest,
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ ok: true, app: "Lobby2", build: BUILD, actions: Object.keys(handlers), msg: "Lobby 서버가 동작 중입니다." });
  try {
    const req = JSON.parse((await request.text()) || "{}");

    if (req.action === "cron") {                 // 1분마다 자동 실행 (supabase/cron.sql)
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || String(req.secret) !== secret) return json({ ok: false, error: "허용되지 않은 요청입니다." });
      let rang = 0;
      try { rang = await runAlarms(); }           // 시각이 된 일정 알림을 휴대폰으로 보낸다 (시간이 중요해서 예약 작업보다 먼저)
      catch (e: any) { console.error("알림 보내기 실패:", e && e.message || e); }
      const ran = await runScheduler();
      const p = kst();
      if (p.hour === 4 && p.minute < 15) await purgeTrash();      // 하루 한 번, 새벽 4시
      return json({ ok: true, ran, rang });
    }

    const pin = Deno.env.get("APP_PIN");
    if (!pin || String(req.pin) !== String(pin)) {
      await new Promise((r) => setTimeout(r, 800));               // 암호를 마구 넣어 보는 시도를 늦춘다
      return json({ ok: false, error: "접속 암호가 맞지 않습니다." });
    }
    const fn = handlers[req.action];
    if (!fn) return json({ ok: false, error: "알 수 없는 요청: " + req.action });
    const out: any = { ok: true, ...(await fn(req)) };
    out.usage = await usageSummary();            // 요청이 끝날 때마다 최신 사용 요금을 함께 보낸다(화면 상단에 표시)
    return json(out);
  } catch (err: any) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
});

// ───────────────────────── init ─────────────────────────
async function actInit() {
  const reports = await getReports(60);
  const docCount = (await run<any[]>(db.from("docs").select("id"))).length;
  return {
    version: 3, categories: await getCategories(), types: TYPES, states: STATES,
    today: today(), recent: await recent(5),
    unread: reports.filter((r) => r.읽음 !== "Y").length,
    latestReport: reports[0] || null, docCount,
  };
}

// ───────────────────────── 입력 습관 학습 ─────────────────────────
// 모델을 따로 훈련하지 않고, 카일님이 저장·확인한 기록을 "예시"로 보여 줘서 비슷한 말은 같은 방식으로 정리하게 한다.
// 기록이 쌓일수록 예시가 늘어나 정확해지고, 화면에서 유형·분류를 고친 기록은 더 높은 비중으로 참고한다.
function grams(s: string) {
  // 숫자·금액·날짜·어미처럼 어떤 입력에나 나오는 말은 빼야 "비슷한 내용"만 걸러진다
  const t = String(s || "").toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/(오늘|어제|그저께|내일|모레|아침|점심|저녁|오전|오후|방금|지난주|이번주|했었|했어요|했는데|했어|했다|했음|갔다|갔어|왔어|왔다|했고|하고|에서|에게|으로|이랑|하고|만원|천원|킬로|원)/g, " ")
    .replace(/[^0-9a-z가-힣]/g, "");
  const set: Record<string, number> = {}; let n = 0;
  for (let i = 0; i < t.length - 1; i++) { const g = t.substr(i, 2); if (!set[g]) { set[g] = 1; n++; } }
  return { set, n };
}
function similarity(a: any, b: any) {
  if (!a.n || !b.n) return 0;
  let c = 0; Object.keys(a.set).forEach((g) => { if (b.set[g]) c++; });
  return c >= 2 ? c / Math.sqrt(a.n * b.n) : 0;      // 겹치는 글자쌍이 2개 미만이면 우연의 일치로 본다
}

/** 화면에서 유형·분류를 고친 기록 → { 기록ID: '분류 차량→생활' } */
async function correctionMap() {
  const o: Record<string, string> = {};
  try {
    const rows = await run<any[]>(db.from("history").select("record_id,field,old_value,new_value")
      .in("field", ["유형", "분류"]).eq("via", "화면").order("id", { ascending: false }).limit(300));
    rows.reverse().forEach((h) => { o[h.record_id] = h.field + " " + h.old_value + "→" + h.new_value; });
  } catch (_e) { /* 이력이 없어도 학습은 계속 */ }
  return o;
}

async function learnedHints(text: string) {
  try {
    const all = (await getRecords()).filter((r) => r.상태 !== "삭제").slice(-CONFIG.LEARN_SCAN);
    if (all.length < 3) return "";
    const fixes = await correctionMap();
    const q = grams(text);

    const scored = all.map((r) => {
      const src = String(r.원문 || (r.제목 + " " + r.내용));
      let s = similarity(q, grams(src));
      if (fixes[r.ID] || r.수정일시) s *= 1.3;          // 카일님이 직접 고친 기록은 더 믿을 만한 예시
      return { r, s, src };
    }).filter((x) => x.s >= 0.15).sort((a, b) => b.s - a.s);

    const seen: Record<string, number> = {}, ex: string[] = [];
    scored.forEach((x) => {
      const key = [x.r.유형, x.r.분류, x.r.제목].join("|");
      if (seen[key] || ex.length >= CONFIG.LEARN_EXAMPLES) return;
      seen[key] = 1;
      const r = x.r;
      ex.push('  "' + x.src.replace(/\s+/g, " ").slice(0, 60) + '" → 유형=' + r.유형 + ", 분류=" + r.분류 + ', 제목="' + r.제목 + '"' +
        (r.태그 ? ", 태그=" + r.태그 : "") + (r.금액 !== null ? ", 금액 있음" : "") + (fixes[r.ID] ? "  (카일님이 고침: " + fixes[r.ID] + ")" : ""));
    });

    // 전체 습관: 유형별로 자주 쓰는 분류, 자주 쓰는 태그
    const byType: Record<string, Record<string, number>> = {}, tags: Record<string, number> = {};
    all.forEach((r) => {
      byType[r.유형] = byType[r.유형] || {}; byType[r.유형][r.분류] = (byType[r.유형][r.분류] || 0) + 1;
      String(r.태그 || "").split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => tags[t] = (tags[t] || 0) + 1);
    });
    const top = (o: Record<string, number>) => Object.keys(o).sort((a, b) => o[b] - o[a]);
    const habit = Object.keys(byType).map((t) => t + "→" + top(byType[t]).slice(0, 3).map((c) => c + "(" + byType[t][c] + ")").join(", ")).join(" / ");
    const tagLine = top(tags).slice(0, 15).join(", ");

    const out = ["[카일님의 입력 습관 — 지금까지 저장·확인된 " + all.length + "건에서 배운 것. 참고용이며 위 규칙·JSON 형식이 우선한다]"];
    if (ex.length) out.push("비슷했던 과거 입력(같은 방식으로 정리):", ex.join("\n"));
    if (habit) out.push("유형별 자주 쓰는 분류: " + habit);
    if (tagLine) out.push("자주 쓰는 태그(같은 뜻이면 이 표현으로 통일): " + tagLine);
    return out.join("\n");
  } catch (_e) { return ""; }       // 학습이 실패해도 입력 정리는 평소처럼 동작
}

// ───────────────────────── 기록: 정리(parse) ─────────────────────────
async function actParse(req: any) {
  const text = mask(String(req.text || "").trim());
  if (!text) throw new Error("말씀하신 내용이 비어 있습니다.");
  const cats = await getCategories();

  const system = [
    "너는 카일님의 개인 비서 Lobby다. 카일님의 음성 발화를 기록용 JSON으로 정리한다.",
    dateContext(),
    "유형(8개 중 하나): " + TYPES.join(", "),
    "  일상=있었던 일, 지출=돈을 쓴 기록(금액 필수), 일정=앞으로의 개인 약속, 업무일정=회사 약속·마감,",
    "  정보=기억해 둘 사실, 특이점=평소와 다른 일·주의할 일, 아이디어=떠오른 생각,",
    '  할일=앞으로 해야 할 일("~해야 돼", "~사야지", "~까먹지 말기"). 할일의 대상일은 기한이고, 기한 언급이 없으면 ""로 둔다.',
    "분류(기존): " + cats.map((c) => c.name).join(", "),
    "규칙:",
    '- 한 발화에 여러 건이 있으면 각각 나눈다. 호출어("로비야", "안녕 로비" 등)는 내용에서 뺀다.',
    '- 대상일은 yyyy-MM-dd. "어제"=오늘-1, "그저께"=오늘-2, "다음 주 X요일"=다음 주(월~일)의 X요일, "이번 주말"=이번 주 토요일(내용에 "주말" 표기), "다음 달 초"=다음 달 1일(내용에 "초순" 표기).',
    '- 날짜 언급이 없으면 일상·지출·정보·특이점·아이디어는 오늘(할일은 ""). 일정·업무일정인데 날짜가 없으면 대상일을 ""로 두고 확인필요에 질문을 적는다.',
    '- 대상시각은 HH:mm(24시간). 없으면 "".',
    '- "~시에 알려 줘", "~하라고 깨워 줘", "알림 맞춰 줘", "리마인드 해 줘"처럼 그 시각에 알려 달라는 말은 할일(약속·회의면 일정·업무일정)로 정리하고 대상일·대상시각을 그 시각으로 채운다.',
    '- 알림: 몇 분 전에 소리로 알려 줄지(분, 정수). "30분 전에 알려 줘"=30, "1시간 전에"=60, "하루 전에"=1440, "~시에 알려 줘"·"그때 알려 줘"=0. 알림이 필요 없다고 하면 -1. 알림 언급이 없으면 null.',
    '- 금액은 원 단위 정수. "8만5천"=85000. 없으면 null.',
    "- 제목은 20자 안팎 한 줄 요약, 내용은 정리된 본문(수치·조건 보존).",
    '- 상태: 일정·업무일정·할일은 "예정", 나머지는 "정상".',
    "- 태그는 검색용 핵심어 1~4개.",
    "- 기존 분류에 맞지 않으면 새 분류명을 제안하고 새분류=true, 분류설명에 한 줄 설명. 억지로 새 분류를 만들지 말 것.",
    '- 유형이 정보이고 "항목=값"으로 정리 가능하면 프로필항목/프로필값을 채운다(예: "차 타이어 규격" / "235/55R19").',
    '- 카드번호·계좌번호·비밀번호는 절대 옮겨 적지 말고 "***"로 가린다.',
    await learnedHints(text),
    "반드시 JSON만 출력:",
    '{"items":[{"유형":"","분류":"","새분류":false,"분류설명":"","대상일":"","대상시각":"","제목":"","내용":"","금액":null,"인물":[],"장소":"","태그":[],"상태":"","알림":null,"프로필항목":"","프로필값":"","확인필요":""}]}',
  ].join("\n");

  const out = extractJson(await callClaude(system, text, 2000));
  const lead = alarmVal(req.alarmLead) || String(CONFIG.ALARM_DEFAULT_MIN);
  const items = (out.items || []).map((it: any) => normalizeItem(it, cats, lead));
  return { items, raw: text };
}

function normalizeItem(it: any, cats: any[], lead = String(CONFIG.ALARM_DEFAULT_MIN)) {
  const names = cats.map((c) => c.name);
  const o: any = {
    유형: TYPES.indexOf(it.유형) >= 0 ? it.유형 : "일상",
    분류: String(it.분류 || "생활").trim(),
    대상일: String(it.대상일 || ""),
    대상시각: String(it.대상시각 || ""),
    제목: String(it.제목 || "").slice(0, 60),
    내용: String(it.내용 || ""),
    금액: toNum(it.금액),
    인물: listStr(it.인물),
    장소: String(it.장소 || ""),
    태그: listStr(it.태그),
    상태: STATES.indexOf(it.상태) >= 0 ? it.상태 : (/일정|할일/.test(it.유형) ? "예정" : "정상"),
    알림: "",
    프로필항목: String(it.프로필항목 || ""),
    프로필값: String(it.프로필값 || ""),
    확인필요: String(it.확인필요 || ""),
  };
  o.새분류 = names.indexOf(o.분류) < 0;
  o.분류설명 = o.새분류 ? String(it.분류설명 || "") : "";
  // 알림: 말씀하신 대로, 언급이 없으면 시각이 있는 일정·업무일정은 기본 알림(10분 전), 시각이 있는 할일은 정각
  const asked = it.알림 === null || it.알림 === undefined || it.알림 === "" ? null : Number(it.알림);
  if (asked !== null && isFinite(asked)) o.알림 = asked < 0 ? "" : alarmVal(asked);
  else if (o.상태 === "예정" && o.대상시각) o.알림 = /일정/.test(o.유형) ? lead : o.유형 === "할일" ? "0" : "";
  return o;
}

// ───────────────────────── 기록: 저장(save) ─────────────────────────
async function actSave(req: any) {
  const items: any[] = req.items || [];
  if (!items.length) throw new Error("저장할 기록이 없습니다.");
  const raw = mask(String(req.raw || ""));
  const now = nowStr(), day = today();
  const prefix = day.replace(/-/g, "");
  let seq = await nextSeq(prefix);

  const known = (await getCategories()).map((c) => c.name);
  for (const it of items) {
    if (it.새분류승인 && it.분류 && known.indexOf(it.분류) < 0) {
      await run(db.from("categories").upsert({ name: it.분류, description: it.분류설명 || "", added: day }));
      known.push(it.분류);
    }
  }

  const rows: any[] = [], ids: string[] = [];
  for (const it of items) {
    const id = prefix + "-" + ("00" + (seq++)).slice(-3);
    ids.push(id);
    rows.push({
      id, created_at: now, target_date: it.대상일 || (it.유형 === "할일" ? "" : day), target_time: it.대상시각 || "",
      type: TYPES.indexOf(it.유형) >= 0 ? it.유형 : "일상", category: known.indexOf(it.분류) >= 0 ? it.분류 : "생활",
      title: mask(it.제목 || ""), content: mask(it.내용 || ""), amount: toNum(it.금액),
      people: listStr(it.인물), place: it.장소 || "", tags: listStr(it.태그),
      status: STATES.indexOf(it.상태) >= 0 ? it.상태 : "정상", raw, updated_at: "", deleted_at: "",
    });
    const r = rows[rows.length - 1], alarm = alarmVal(it.알림);
    if (alarm) { r.alarm = alarm; r.alarm_at = alarmAtOf(toKo(r, REC_MAP)); }   // 알림 없는 기록은 알림 칸을 비워 둔다(표 업데이트 전에도 저장되게)
    if (it.유형 === "정보" && it.프로필항목 && it.프로필값) {
      await run(db.from("profile").upsert({ key: String(it.프로필항목).trim(), value: mask(it.프로필값), updated: day }));
    }
  }
  await alarmSafe(run(db.from("records").insert(rows, { defaultToNull: false })));   // 알림 칸이 없는 행은 빈칸(기본값)으로
  const alarms = rows.filter((r) => r.alarm_at).map((r) => alarmPick(toKo(r, REC_MAP)));
  return { ids, recent: await recent(5), alarms };
}

async function nextSeq(prefix: string) {
  // 휴지통으로 옮겨진 기록의 번호도 다시 쓰지 않는다
  let max = 0;
  for (const table of ["records", "trash"]) {
    const rows = await run<any[]>(db.from(table).select("id").like("id", prefix + "-%").order("id", { ascending: false }).limit(1));
    if (rows.length) max = Math.max(max, parseInt(String(rows[0].id).split("-")[1], 10) || 0);
  }
  return max + 1;
}

// ───────────────────────── 대화(talk): 의도 판단 → 기록 / 질문 / 예약 ─────────────────────────
async function actTalk(req: any) {
  const text = mask(String(req.text || req.question || "").trim());
  if (!text) throw new Error("말씀하신 내용이 비어 있습니다.");
  const history = (req.history || []).slice(-4).map((h: any) => ({ 카일: String(h.q || "").slice(0, 300), Lobby: String(h.a || "").slice(0, 400) }));

  const plan = await makePlan(text, history);
  let intent = plan.의도 || "질문";
  if (intent === "브리핑") return { intent: "브리핑", ...(await buildBrief()) };
  if (req.mode === "question" && (intent === "기록" || intent === "예약")) intent = "질문";

  if (intent === "기록") {
    const r = await actParse({ text, alarmLead: req.alarmLead });
    return { intent: "기록", items: r.items, raw: r.raw };
  }
  if (intent === "예약" && plan.예약) {
    const t = normalizeTask(plan.예약);
    t.다음실행 = nextRun(t, new Date());
    return { intent: "예약", task: t, speech: describeTask(t) + " 이렇게 예약할까요?" };
  }
  return { intent: "질문", ...(await answer(text, plan, history)) };
}

async function makePlan(text: string, history: any[]) {
  const cats = (await getCategories()).map((c) => c.name);
  const docNames = await getDocNames();
  const sys = [
    "너는 카일님의 개인 비서 Lobby의 두뇌다. 카일님의 말을 보고 의도를 판단하고 조회계획을 JSON으로 만든다.",
    dateContext(),
    "의도(하나):",
    '  기록 = 있었던 일·지출·앞으로의 일정·기억할 정보·특이점·아이디어를 남기려는 말 ("어제 오일 갈았어 8만원", "다음주 화요일 미라셀 미팅"). 그 시각에 카일님께 알려 달라는 말("내일 3시에 약 먹으라고 알려 줘", "회의 30분 전에 알려 줘", "6시에 깨워 줘")도 기록이다',
    '  질문 = 기록·회사 문서·일반 지식에 대한 물음, 요약·정리·계획 요청, 문서를 보여 달라·읽어 달라는 말 ("이번 주 일정 뭐야?", "CR-747 승인원 검사 항목 알려줘", "작업표준서 보여 줘")',
    '  예약 = 정해진 시각에 Lobby가 기록을 조회·정리해 보고서로 남기도록 맡기는 말 ("매주 월요일 8시에 이번 주 일정 정리해줘", "금요일 오후 5시에 이번 주 지출 알려줘")',
    '  브리핑 = 오늘 하루를 종합해 달라는 말 ("브리핑", "오늘 뭐 해야 돼?", "오늘 할 일·일정·날씨 알려 줘"). 특정 기간(이번 주 등)이나 특정 주제 질문은 브리핑이 아니라 질문.',
    "  대화 = 인사·잡담·감사",
    "  애매하면 질문. 과거형 서술·금액 보고는 기록.",
    "유형: " + TYPES.join(", "),
    "분류: " + cats.join(", "),
    "상태: " + STATES.filter((s) => s !== "삭제").join(", "),
    "Lobby가 읽을 수 있는 회사 문서 목록: " + (docNames.length ? docNames.join(" / ") : "(아직 없음)"),
    "출처(하나): 기록(카일님이 말로 남긴 개인 기록) | 문서(승인원·작업표준서·검사기준·규격·사양·도면 등 회사 문서) | 둘다 | 없음(일반 상식·잡담).",
    "종류: 조회(목록), 통계(합계·횟수·평균), 최근(가장 최근 이력), 요약(기간 회고), 계획(제안), 정보(사실 질문)",
    "규칙:",
    '- 최근대화를 보고 "그거", "아까 그 문서" 같은 말을 해석한다.',
    '- 기간은 대상일 기준. "이번 주"=이번 주 월~일, "이번 달"=1일~말일, "올해"=1/1~12/31, "최근"=지난 30일. 기간 언급이 없고 최근·정보 질문이면 기간 null(전체).',
    "- 검색어는 기록의 제목·내용·태그·인물·장소에서 찾을 핵심 단어(동의어 포함).",
    '- 문서검색어는 문서 본문에서 찾을 핵심어 최대 8개: 모델명·부품명·검사항목·규격값 단어, 한글/영문 표기와 동의어 포함(예: ["CR-747","CR747","외관","치수","공차"]). 도면·사진을 찾는 말이면 "도면"·"사진"도 넣는다. 재질을 물으면 "재질","원료","수지","그레이드"를 함께 넣는다.',
    '- 도면·제품사진·치수·적용 원료를 묻는 말은 출처를 문서(기록도 관련 있으면 둘다)로 한다.',
    "- 문서파일은 카일님이 특정 문서를 지목하면(보여 줘·열어 줘·읽어 줘 포함) 목록에서 그 파일명을 그대로 넣고 출처는 문서로 한다. 아니면 [].",
    "- 분류·유형은 확실할 때만 넣는다. 계산: 합계|횟수|평균|없음. 그룹: 월|분류|유형|없음.",
    '- 의도가 예약이면 예약을 채운다: 이름(10자 안팎), 반복(매일|매주|매월|한번), 요일("월,수" 형식, 매주일 때), 날짜(매월이면 일자 숫자, 한번이면 yyyy-MM-dd), 시각(HH:mm 24시간), 요청(그 시각에 Lobby가 스스로 답할 질문 문장). 아니면 예약은 null.',
    "반드시 JSON만 출력:",
    '{"의도":"질문","출처":"기록","종류":"","기간":{"시작":"","끝":""},"유형":[],"분류":[],"상태":[],"검색어":[],"문서검색어":[],"문서파일":[],"계산":"없음","그룹":"없음","정렬":"최신","개수":30,"예약":null}',
  ].join("\n");
  const user = JSON.stringify({ 최근대화: history || [], 말씀: text });
  const plan = extractJson(await callClaude(sys, user, 700));
  plan.의도 = ["기록", "질문", "예약", "대화", "브리핑"].indexOf(plan.의도) >= 0 ? plan.의도 : "질문";
  plan.출처 = ["기록", "문서", "둘다", "없음"].indexOf(plan.출처) >= 0 ? plan.출처 : "기록";
  if (plan.의도 === "대화" || plan.의도 === "브리핑") plan.출처 = "없음";
  return plan;
}

async function answer(q: string, plan: any, history: any[]) {
  const t0 = Date.now();
  const src = plan.출처 || "기록";
  const useRec = src === "기록" || src === "둘다";
  const useDoc = src === "문서" || src === "둘다";
  const result: any = useRec ? await runPlan(plan) : { rows: [], aiRows: [], stats: null };
  const kws = (plan.문서검색어 && plan.문서검색어.length) ? plan.문서검색어 : (plan.검색어 || []);
  const docs = useDoc ? await searchDocs(kws, plan.문서파일 || [], q) : [];

  const sys = [
    "너는 카일님의 개인 비서 Lobby다. 아래 자료만 근거로 답한다: [조회결과](카일님 기록), [문서발췌](회사 문서), [프로필].",
    dateContext(),
    "규칙:",
    '- [조회결과].통계.일치기록있음이 true이면 기록이 있는 것이다. 절대 "기록이 없다"고 하지 말고 건수·날짜를 근거로 답한다. 조회방식에 "풀어서"가 있으면 조건을 완화해 찾은 것이므로 기록의 제목·내용을 직접 읽고 질문과 관련 있는 것만 세어 답한다(예: 루틴운동=운동·헬스·러닝·스트레칭 등 같은 뜻의 기록).',
    "- 참고기록_검색어불일치는 검색어와 글자는 달라도 같은 뜻일 수 있는 기록이다(기간 밖 기록 포함). 횟수·개수 질문이면 이 목록도 읽고 질문과 같은 활동이면 포함해 직접 센 뒤, 어떤 기록들을 셌는지 상세에 날짜와 함께 적는다.",
    '- 기록·문서에 없는 내용은 지어내지 않는다. 일치기록있음이 false일 때만 기록이 없다고 하고, 그때도 전체기록수와 함께 "기록 N건 중 관련 기록을 찾지 못했다"고 말하며 "해당 기록이 없습니다"라고 말하고 지금 기록할지 묻는다.',
    '- 문서발췌에 답이 없으면 "등록된 문서에서 찾지 못했습니다"라고 말하고, 어떤 문서를 문서 탭에서 올리면 되는지 한 줄로 제안한다.',
    "- 카일님이 문서를 보여 달라·열어 달라고 하면 그 문서가 무엇에 관한 것인지 한두 문장으로 말하고 \"화면에서 바로 열 수 있습니다\"라고 덧붙인다(근거문서에 그 문서의 번호를 넣으면 화면에 열기 버튼이 나온다). 읽어 달라고 하면 음성에 핵심 내용을 3~5문장으로 읽기 좋게 옮긴다.",
    "- 도면·제품사진(형식이 이미지이거나 내용이 [도면]·[사진]으로 시작)을 보여 달라거나 치수·형상을 물으면 근거문서에 그 번호를 꼭 넣는다(화면에 도면·사진 미리보기가 나온다). 같은 제품의 승인원·도면·사진이 함께 있으면 함께 넣는다.",
    "- 치수는 [도면] 판독의 \"뷰·부분 - 치수 이름: 값 공차\"를 근거로, 어느 부분의 치수인지 함께 말한다. 적용 원료·재질은 표제란이나 승인원의 값을 그대로 쓴다.",
    "- 출처가 없음(인사·잡담·일반 상식)이면 알고 있는 지식으로 짧고 따뜻하게 답한다.",
    '- 숫자(합계·건수·평균)는 [조회결과].통계 값을 그대로 쓴다. 직접 다시 계산하지 않는다(단, 조회방식에 "풀어서"가 있으면 기록을 직접 읽고 관련 건만 세어 건수를 말한다).',
    "- 규격·치수·공차·검사기준·수량 같은 문서 수치는 단위까지 원문 그대로 옮긴다. 추정·반올림 금지.",
    "- 최근대화를 참고해 앞 질문과 이어지게 답한다.",
    '- 음성: 존댓말, 1~3문장, 첫 문장에 결론. 금액은 "48만 2천 원"처럼 읽기 쉽게. 문서를 인용하면 "○○ 승인원에 따르면"처럼 문서명만 짧게. 목록이 4건 이상이면 3건까지만 말하고 "나머지는 화면에 정리해 두었습니다".',
    '- 상세: 화면용. 줄바꿈으로 구분한 짧은 줄들. 목록은 "• "로 시작. 금액은 482,000원 형식. 문서 내용 줄 끝에는 (문서명 · 위치)를 붙인다.',
    '- 근거ID: 답변에 쓴 기록 ID 배열(최대 10개). 근거문서: 답변에 쓴 문서발췌 번호 배열(예: ["D1","D3"]).',
    '반드시 JSON만 출력: {"음성":"","상세":"","근거ID":[],"근거문서":[]}',
  ].join("\n");
  const payload = {
    질문: q, 최근대화: history || [], 조회계획: plan,
    조회결과: useRec ? { 통계: result.stats, 기록: result.aiRows, 참고기록_검색어불일치: result.extra } : "(기록은 조회하지 않음)",
    문서발췌: useDoc ? (docs.length ? docs.map((d) => ({ 번호: d.key, 문서: d.파일명, 형식: d.형식, ...(d.메모 ? { 메모: d.메모 } : {}), 위치: d.위치, 내용: d.본문 })) : "(관련 문서 조각을 찾지 못함)") : "(문서는 조회하지 않음)",
    프로필: await getProfile(),
  };
  const ans = extractJson(await callClaude(sys, JSON.stringify(payload), 1800));

  const evid = (ans.근거ID || []).map(String);
  const evidence = result.rows.filter((r: any) => evid.indexOf(r.ID) >= 0).slice(0, 10);
  const dkeys = (ans.근거문서 || []).map(String);
  const used = docs.filter((d) => dkeys.indexOf(d.key) >= 0);
  const links = await docLinks(used.map((d) => d.파일ID));
  const docEvidence = used.map((d) => ({ 파일ID: d.파일ID, 파일명: d.파일명, 형식: d.형식, 메모: d.메모, 위치: d.위치, 쪽: Number((/p\.(\d+)/.exec(d.위치) || [])[1]) || 1,
    링크: links[d.파일ID] || "", 발췌: d.본문.replace(/^\[(도면|사진)\]\s*/, "").replace(/\s+/g, " ").slice(0, 180) }));

  await run(db.from("chat_log").insert({ at: nowStr(), question: q, plan, speech: ans.음성 || "",
    note: "기록 " + (result.stats ? result.stats.건수 : 0) + " / 문서 " + docs.length + " / " + Math.round((Date.now() - t0) / 100) / 10 + "초" }));

  return { speech: ans.음성 || "", detail: ans.상세 || "", evidence, docEvidence, stats: result.stats, plan };
}

async function runPlan(plan: any) {
  const all = (await getRecords()).filter((r) => r.상태 !== "삭제");
  const p = plan || {};
  const from = p.기간 && p.기간.시작, to = p.기간 && p.기간.끝;
  const squash = (t: any) => String(t || "").toLowerCase().replace(/[\s·/_\-]+/g, "");
  const kws: string[] = (p.검색어 || []).map(squash).filter(Boolean);
  const has = (arr: any[], v: any) => !(arr && arr.length) || arr.indexOf(v) >= 0;
  const byPeriod = (r: any) => (!from || dayOf(r) >= from) && (!to || dayOf(r) <= to);
  const byKw = (r: any) => {
    if (!kws.length) return true;
    const hay = squash([r.제목, r.내용, r.태그, r.인물, r.장소, r.분류, r.원문].join(" "));
    return kws.some((k) => hay.indexOf(k) >= 0);
  };
  // 조건을 엄격한 순서대로 시도하고, 0건이면 조금씩 풀어서 다시 찾는다 (AI가 짠 계획이 어긋나도 기록을 놓치지 않게)
  const tries: [string, (r: any) => boolean][] = [
    ["", (r) => byPeriod(r) && has(p.유형, r.유형) && has(p.분류, r.분류) && has(p.상태, r.상태) && byKw(r)],
    ["유형·분류·상태 조건을 풀어서 찾음", (r) => byPeriod(r) && byKw(r)],
    ["기간 조건을 풀어서 찾음(전체 기간)", (r) => byKw(r)],
  ];
  let rows: any[] = [], relaxed = "";
  for (let i = 0; i < tries.length; i++) {
    rows = all.filter(tries[i][1]);
    if (rows.length) { relaxed = tries[i][0]; break; }
  }
  const matched = rows.length > 0;
  if (!matched) { relaxed = "일치하는 기록 없음 — 최근 기록을 참고용으로 제공"; rows = all.filter(byPeriod); if (!rows.length) rows = all.slice(); }
  const asc = p.정렬 === "오래된";
  rows.sort((a, b) => (dayOf(a) + a.대상시각).localeCompare(dayOf(b) + b.대상시각) * (asc ? 1 : -1));

  const money = rows.map((r) => r.금액).filter((v) => typeof v === "number");
  const sum = money.reduce((s, v) => s + v, 0);
  const stats: any = {
    건수: rows.length, 금액건수: money.length, 합계: sum,
    평균: money.length ? Math.round(sum / money.length) : 0,
    기간: { 시작: from || "", 끝: to || "" },
    조회방식: relaxed || "계획대로 정확히 일치", 일치기록있음: matched, 전체기록수: all.length,
  };
  const g = p.그룹;
  if (g && g !== "없음") {
    const key = (r: any) => g === "월" ? dayOf(r).slice(0, 7) : (g === "분류" ? r.분류 : r.유형);
    const groups: Record<string, any> = {};
    rows.forEach((r) => {
      const k = key(r) || "(없음)";
      groups[k] = groups[k] || { 건수: 0, 합계: 0 };
      groups[k].건수++;
      if (typeof r.금액 === "number") groups[k].합계 += r.금액;
    });
    stats.그룹 = groups;
  }

  const wide = relaxed || p.종류 === "통계" || p.계산 === "횟수";
  const limit = wide ? CONFIG.MAX_ROWS_TO_AI : Math.min(Number(p.개수) || CONFIG.MAX_ROWS_TO_AI, CONFIG.MAX_ROWS_TO_AI);
  const aiRows = rows.slice(0, limit).map((r) => ({
    ID: r.ID, 날짜: dayOf(r), 시각: r.대상시각, 유형: r.유형, 분류: r.분류,
    제목: r.제목, 내용: r.내용, 금액: r.금액, 인물: r.인물, 장소: r.장소, 상태: r.상태,
    ...(r.알림시각 ? { 알림시각: r.알림시각 } : {}),
  }));
  // 검색어에 안 걸렸지만 동의어일 수 있는 기록(예: 루틴운동 ↔ 러닝·헬스)을 AI가 직접 판단하도록 최근 기록을 함께 넘긴다
  let extra: any[] = [];
  if (kws.length && matched) {
    const inRows: Record<string, number> = {}; rows.forEach((r) => inRows[r.ID] = 1);
    extra = all.filter((r) => !inRows[r.ID])
      .sort((a, b) => (dayOf(b) + b.대상시각).localeCompare(dayOf(a) + a.대상시각)).slice(0, 40)
      .map((r) => ({ ID: r.ID, 날짜: dayOf(r), 유형: r.유형, 분류: r.분류, 제목: r.제목, 내용: String(r.내용).slice(0, 60), 상태: r.상태 }));
  }
  return { rows, aiRows, stats, extra };
}

// ───────────────────────── 회사 문서: 올리기 · 읽기(색인) · 검색 ─────────────────────────
// 화면이 파일을 Storage에 직접 올리고(uploadUrl → 올리기), 올린 뒤 indexDoc으로 내용을 읽어 조각(doc_chunks)으로 저장한다.
function kindOf(name: string, mime: string) {
  const n = String(name || "").toLowerCase(), m = String(mime || "");
  if (m === "application/pdf" || /\.pdf$/.test(n)) return "PDF";
  if (/\.docx$/.test(n)) return "워드";
  if (/\.xlsx?$/.test(n) || /\.xlsm$/.test(n)) return "엑셀";
  if (/\.pptx$/.test(n)) return "파워포인트";
  if (/^image\/(jpeg|png|gif|webp)/.test(m) || /\.(jpe?g|png|gif|webp)$/.test(n)) return "이미지";
  if (/\.(txt|csv|md)$/.test(n) || /^text\//.test(m)) return "텍스트";
  if (/\.hwpx?$/.test(n)) return "미지원(한글 HWP는 PDF로 저장해 올려 주세요)";
  if (/\.(doc|ppt)$/.test(n)) return "미지원(옛 형식입니다. docx·pptx 또는 PDF로 저장해 올려 주세요)";
  return "미지원(" + (n.split(".").pop() || m) + ")";
}
const usableKind = (kind: string) => kind.indexOf("미지원") !== 0;

async function actUploadUrl(req: any) {
  const name = String(req.name || "").trim().slice(0, 200);
  const size = Number(req.size) || 0;
  if (!name) throw new Error("파일 이름이 없습니다.");
  if (size > CONFIG.UPLOAD_MAX_MB * 1024 * 1024) throw new Error("파일이 " + CONFIG.UPLOAD_MAX_MB + "MB를 넘어 올릴 수 없습니다.");
  const kind = kindOf(name, req.type);
  const id = crypto.randomUUID();
  const ext = (name.match(/\.([0-9a-z]{1,8})$/i) || ["", "bin"])[1].toLowerCase();
  const path = id + "." + ext;                         // 저장소 경로에는 한글을 쓸 수 없어 ID로 저장하고, 이름은 표에 남긴다
  const { data, error } = await db.storage.from(CONFIG.BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error("올리기 준비 실패: " + error.message);
  const row: any = { id, name, kind: usableKind(kind) ? kind : "미지원", path, size, uploaded_at: nowStr(), status: usableKind(kind) ? "올리는 중" : kind };
  const memo = String(req.memo || "").trim().slice(0, 100);
  if (memo) row.memo = memo;
  await memoSafe(run(db.from("docs").insert(row)));
  return { id, uploadUrl: data.signedUrl, kind };
}

/** 문서의 품번·메모 바꾸기 (다시 읽지 않아도 바로 검색에 쓰인다) */
async function actDocMemo(req: any) {
  await memoSafe(run(db.from("docs").update({ memo: String(req.memo || "").trim().slice(0, 100) }).eq("id", String(req.id))));
  return await actDocs();
}

/** 메모 칸이 없는 DB(아직 docs_media.sql을 실행하지 않음)에서 나는 오류를 알아듣기 쉽게 바꾼다 */
async function memoSafe<T>(p: Promise<T>) {
  try { return await p; } catch (e: any) {
    if (/memo/.test(String(e && e.message))) throw new Error("품번·메모 기능용 표 업데이트가 필요합니다. Supabase SQL Editor에서 supabase/migrations/20261008000000_docs_media.sql을 한 번 실행해 주세요.");
    throw e;
  }
}

async function actIndexDoc(req: any) {
  const doc = (await run<any[]>(db.from("docs").select("*").eq("id", String(req.id))))[0];
  if (!doc) throw new Error("문서를 찾지 못했습니다.");
  const status = await indexDoc(doc);
  return { status, ...(await actDocs()) };
}

/** 파일 하나를 읽어 조각으로 저장하고 상태를 돌려준다 */
async function indexDoc(doc: any) {
  let segs: Seg[] = [], status = "완료";
  if (doc.kind === "미지원") return doc.status;
  try {
    const { data: blob, error } = await db.storage.from(CONFIG.BUCKET).download(doc.path);
    if (error || !blob) throw new Error("파일을 아직 받지 못했습니다. 다시 올려 주세요");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = await extractSegments(bytes, doc.kind, doc.name, doc.memo || "");
    segs = r.segs;
    if (!segs.some((s) => s.text.trim())) status = "글자 없음";
    else if (r.partial) status = "일부만 읽음(문서가 길어 앞부분만 읽었습니다. 나눠서 올려 주세요)";
  } catch (e: any) { status = "실패: " + String(e && e.message || e).slice(0, 80); }

  await run(db.from("doc_chunks").delete().eq("doc_id", doc.id));
  const chunks = chunkSegments(segs);
  for (let i = 0; i < chunks.length; i += 200) {
    await run(db.from("doc_chunks").insert(chunks.slice(i, i + 200).map((c, k) => ({ doc_id: doc.id, name: doc.name, seq: i + k + 1, loc: c.loc, body: c.text }))));
  }
  await run(db.from("docs").update({ chunks: chunks.length, read_at: nowStr(), status }).eq("id", doc.id));
  return status;
}

type Seg = { loc: string; text: string };

/** 파일 → [{loc, text}] 조각 전 단계 */
async function extractSegments(bytes: Uint8Array, kind: string, name: string, memo = ""): Promise<{ segs: Seg[]; partial?: boolean }> {
  switch (kind) {
    case "텍스트": return { segs: [{ loc: "", text: new TextDecoder("utf-8").decode(bytes) }] };
    case "워드": return { segs: docxSegments(bytes) };
    case "파워포인트": return { segs: pptxSegments(bytes) };
    case "엑셀": return { segs: await sheetSegments(bytes) };
    case "이미지": return await imageSegmentsByClaude(bytes, name);
    case "PDF": {
      let segs: Seg[] = [];
      try { segs = await pdfSegments(bytes); } catch (_e) { segs = []; }
      const len = segs.reduce((s, x) => s + x.text.replace(/\s/g, "").length, 0);
      // 도면은 글자가 들어 있어도 숫자만 흩어져 나와 어느 부분 치수인지 알 수 없으므로, Claude가 그림으로 보고 읽는다
      if (isDrawing(name + " " + memo, segs) && bytes.length <= CONFIG.PDF_AI_MAX_MB * 1024 * 1024) {
        try { const d = await pdfSegmentsByClaude(bytes, true); if (d.segs.some((x) => x.text.trim())) return d; } catch (_e) { /* 실패하면 뽑은 글자로 */ }
      }
      if (len >= 200) return { segs };
      return await pdfSegmentsByClaude(bytes);   // 스캔 PDF 등 글자를 못 뽑은 경우
    }
  }
  return { segs: [] };
}

const xmlText = (s: string) => s.replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

function docxSegments(bytes: Uint8Array): Seg[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"]; if (!xml) throw new Error("워드 문서를 열지 못했습니다");
  let s = strFromU8(xml).replace(/<w:(instrText|delText)[\s\S]*?<\/w:\1>/g, "");
  // 표는 한 행을 "칸 | 칸 | 칸" 한 줄로
  s = s.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = row.split(/<\/w:tc>/).slice(0, -1).map((c) => xmlText(c.replace(/<\/w:p>/g, " ")).replace(/\s+/g, " ").trim());
    return cells.join(" | ") + "\n";
  });
  s = s.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n");
  return [{ loc: "", text: xmlText(s) }];
}

function pptxSegments(bytes: Uint8Array): Seg[] {
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
  return Object.keys(files)
    .map((n) => ({ n: Number((n.match(/slide(\d+)\.xml$/) || [])[1]), xml: strFromU8(files[n]) }))
    .sort((a, b) => a.n - b.n)
    .map((sl) => ({ loc: "슬라이드 " + sl.n, text: xmlText(sl.xml.replace(/<\/a:tc>/g, " | ").replace(/<\/a:tr>/g, "\n").replace(/<a:br[^>]*\/>/g, "\n").replace(/<\/a:p>/g, "\n")).replace(/\n{2,}/g, "\n").trim() }))
    .filter((s) => s.text);
}

async function sheetSegments(bytes: Uint8Array): Promise<Seg[]> {
  const XLSX: any = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const wb = XLSX.read(bytes, { type: "array" });
  return wb.SheetNames.map((name: string) => {
    const v: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }).slice(0, 3000);
    const lines = v.map((row) => {
      const r = row.map((c) => String(c)); while (r.length && r[r.length - 1].trim() === "") r.pop();
      return r.join(" | ");
    }).filter((l) => l.replace(/[\s|]/g, ""));
    return { loc: "시트 " + name, text: lines.join("\n") };
  }).filter((s: Seg) => s.text);
}

async function pdfSegments(bytes: Uint8Array): Promise<Seg[]> {
  const { extractText, getDocumentProxy }: any = await import("npm:unpdf");
  const pdf = await getDocumentProxy(bytes.slice());      // 원본은 Claude로 다시 보낼 수 있어 사본을 넘긴다
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t, i) => ({ loc: "p." + (i + 1), text: t })).filter((s) => s.text.trim());
}

const TRANSCRIBE = '글자를 빠짐없이 옮겨 적어라. 표는 한 행을 "칸 | 칸 | 칸" 한 줄로 적는다. 도면의 치수·공차·주석·표제란도 적는다. 요약·설명 없이 원문만 출력.';

// 도면 판독: 숫자만 옮기면 어느 부분 치수인지 알 수 없으므로 "부분 - 치수: 값 공차" 형태로 정리하게 한다
const DRAWING = [
  "이 도면을 보고 아래 순서로 빠짐없이 적어라. 보이는 값만 적고 추정하지 않는다. 읽기 어려운 값은 (판독 불가)로 적는다.",
  "■ 표제란: 도번, 품번, 품명, 재질·적용 원료(그레이드 포함), 색상, 척도, 단위, 리비전, 작성·승인일 등 보이는 항목을 \"항목: 값\"으로 한 줄씩",
  "■ 치수: 한 줄에 하나씩 \"뷰·부분 - 치수 이름: 값 공차\" (예: \"정면도 - 전장: 142.0 ±0.05 mm\", \"측면도 - 체결 구멍 지름: Ø3.2 +0.1/0\"). Ø·R·C·±·기하공차 기호와 단위는 그대로",
  "■ 일반공차·주석·표면처리·검사 기준: 원문 그대로",
  "■ 형상: 어떤 부품인지, 형태와 주요 특징을 두세 문장으로",
  "■ 그 밖의 글자: 위에 들어가지 않은 표·글자를 원문 그대로",
].join("\n");
const DRAWING_NAME = /(도면|drawing|dwg|dxf|assy|조립도|부품도|외형도|제작도|금형도)/i;
/** 도면인지: 파일 이름·메모에 도면이라는 말이 있거나, 뽑은 글자 대부분이 치수처럼 생긴 숫자인 짧은 PDF */
function isDrawing(label: string, segs: Seg[]) {
  if (DRAWING_NAME.test(label)) return true;
  if (!segs.length || segs.length > 30) return false;
  const words = segs.map((x) => x.text).join(" ").split(/\s+/).filter(Boolean);
  if (words.length < 15 || words.length / segs.length > 400) return false;     // 한 쪽에 글이 빽빽하면 일반 문서
  const dims = words.filter((w) => /^[Ø⌀φRCM±+\-]?\d+([.,]\d+)?(°|mm)?$/i.test(w) || /^[±+\-]\d/.test(w)).length;
  return dims / words.length >= 0.35;
}

async function pdfSegmentsByClaude(bytes: Uint8Array, drawing = false) {
  if (bytes.length > CONFIG.PDF_AI_MAX_MB * 1024 * 1024) throw new Error("글자를 뽑을 수 없는 PDF(스캔본)인데 " + CONFIG.PDF_AI_MAX_MB + "MB를 넘어 읽지 못했습니다");
  const content = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(bytes) } },
    { type: "text", text: drawing ? DRAWING + "\n각 페이지 시작에 [p.번호]를 붙인다." : "이 PDF의 " + TRANSCRIBE + " 각 페이지 시작에 [p.번호]를 붙인다." },
  ];
  const r = await callClaudeFull("너는 문서 전사 도구다. 원문을 정확히 옮겨 적는다.", content, 16000);
  const parts = r.text.split(/\[p\.(\d+)\]/);
  const segs: Seg[] = [];
  const tag = drawing ? "[도면] " : "";             // "도면"으로 물어도 찾을 수 있게 앞에 붙인다
  if (parts[0].trim()) segs.push({ loc: "", text: tag + parts[0] });
  for (let i = 1; i < parts.length; i += 2) segs.push({ loc: "p." + parts[i], text: tag + (parts[i + 1] || "") });
  return { segs, partial: r.cut };
}

async function imageSegmentsByClaude(bytes: Uint8Array, name: string) {
  if (bytes.length > CONFIG.IMAGE_MAX_MB * 1024 * 1024) throw new Error("사진이 " + CONFIG.IMAGE_MAX_MB + "MB를 넘어 읽지 못했습니다. 크기를 줄여 올려 주세요");
  const n = name.toLowerCase();
  const media = /\.png$/.test(n) ? "image/png" : /\.gif$/.test(n) ? "image/gif" : /\.webp$/.test(n) ? "image/webp" : "image/jpeg";
  const content = [
    { type: "image", source: { type: "base64", media_type: media, data: encodeBase64(bytes) } },
    { type: "text", text: [
      "이 사진이 무엇인지 첫 줄에 \"종류: 제품사진\", \"종류: 도면\", \"종류: 문서\", \"종류: 기타\" 중 하나로 적어라.",
      "도면이면 이어서 다음을 따른다.\n" + DRAWING,
      "문서면 이어서 " + TRANSCRIBE,
      "제품사진·기타면 이어서 \"설명:\" 줄에 무엇인지, 형태·색상·재질감·크기감·특징을 3~5문장으로 적고, 보이는 품번·각인·라벨 글자가 있으면 \"글자:\" 줄에 그대로 적는다.",
    ].join("\n") },
  ];
  const r = await callClaudeFull("너는 문서·도면·제품사진 판독 도구다. 보이는 것만 정확히 적는다.", content, 8000);
  return { segs: [{ loc: "사진", text: "[사진] " + r.text }], partial: r.cut };
}

function chunkSegments(segs: Seg[]) {
  const out: Seg[] = [], size = CONFIG.CHUNK_SIZE, ov = CONFIG.CHUNK_OVERLAP;
  segs.forEach((sg) => {
    const text = String(sg.text || "").replace(/\r/g, "").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    if (text.length <= size) { out.push({ loc: sg.loc, text }); return; }
    let pos = 0, part = 1;
    while (pos < text.length) {
      let end = Math.min(text.length, pos + size);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end);
        if (nl > pos + size * 0.6) end = nl;
      }
      out.push({ loc: (sg.loc ? sg.loc + " · " : "") + "구간 " + part, text: text.slice(pos, end).trim() });
      if (end >= text.length) break;
      pos = Math.max(end - ov, pos + 1); part++;
    }
  });
  return out;
}

async function getDocNames() {
  const rows = await docRows("name,memo", (q) => q.order("name").limit(120));
  return rows.map((r) => String(r.name) + (r.memo ? " (" + r.memo + ")" : "")).filter(Boolean);
}
/** docs 표 읽기. 메모 칸이 아직 없으면(표 업데이트 전) 메모 없이 읽는다 */
async function docRows(cols: string, more: (q: any) => any = (q) => q): Promise<any[]> {
  try { return await run<any[]>(more(db.from("docs").select(cols))); }
  catch (e: any) {
    if (!/memo/.test(String(e && e.message))) throw e;
    return await run<any[]>(more(db.from("docs").select(cols.split(",").filter((c) => c.trim() !== "memo").join(","))));
  }
}

const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** 문서 조각 검색: 키워드가 많이 맞는 조각을 골라 Claude에게 넘긴다 */
async function searchDocs(keywords: string[], files: string[], q: string) {
  let kws = (keywords || []).map((k) => String(k).trim()).filter((k) => k.length >= 2);
  if (!kws.length) kws = String(q).split(/[\s,.?!]+/).filter((k) => k.length >= 2).slice(0, 6);
  kws = kws.filter((k, i) => kws.indexOf(k) === i).slice(0, 6);

  const want = (files || []).map(String).filter(Boolean);
  const fileOk = (name: string) => !want.length || want.some((w) => name.indexOf(w) >= 0 || w.indexOf(name) >= 0);

  const score: Record<string, number> = {};
  for (const k of kws) {
    const pat = "%" + likeEsc(k) + "%";
    const hits = await run<any[]>(db.from("doc_chunks").select("id,name").ilike("body", pat).limit(500));
    const w = 1 / Math.log(2 + hits.length / 5);      // 흔한 단어는 가중치를 낮춤
    hits.filter((h) => fileOk(h.name)).forEach((h) => {
      score[h.id] = (score[h.id] || 0) + w + (String(h.name).toLowerCase().indexOf(k.toLowerCase()) >= 0 ? 0.5 : 0);
    });
    // 파일 이름·품번 메모가 맞는 문서는 본문에 그 말이 없어도 찾는다 (예: "CR-747 제품사진" → CR-747_제품사진.jpg, 메모 "CR-747")
    const byName = await docRows("id,name,memo", (q) => q.ilike("name", pat).limit(50));
    const byMemo = await docRows("id,name,memo", (q) => q.ilike("memo", pat).limit(50)).catch(() => []);
    const docIds = [...byName, ...byMemo].filter((d) => fileOk(d.name)).map((d) => String(d.id)).filter((id, i, a) => a.indexOf(id) === i);
    if (docIds.length) {
      const heads = await run<any[]>(db.from("doc_chunks").select("id").in("doc_id", docIds).lte("seq", 2).limit(100));
      heads.forEach((h) => { score[h.id] = (score[h.id] || 0) + 1; });
    }
  }
  let ids = Object.keys(score).sort((a, b) => score[b] - score[a]).slice(0, CONFIG.MAX_DOC_CHUNKS_TO_AI).map(Number);
  if (!ids.length && want.length) {                   // 지목한 문서가 있으면 앞부분이라도
    const head = await run<any[]>(db.from("doc_chunks").select("id,name").lte("seq", CONFIG.MAX_DOC_CHUNKS_TO_AI).order("doc_id").order("seq").limit(1000));
    ids = head.filter((h) => fileOk(h.name)).slice(0, CONFIG.MAX_DOC_CHUNKS_TO_AI).map((h) => h.id);
  }
  if (!ids.length) return [];
  const rows = await run<any[]>(db.from("doc_chunks").select("*").in("id", ids));
  const info: Record<string, any> = {};
  (await docRows("id,kind,memo", (q) => q.in("id", rows.map((r) => r.doc_id)))).forEach((d) => { info[d.id] = d; });
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map((v: any, i) => ({
    key: "D" + (i + 1), 파일ID: String(v.doc_id), 파일명: String(v.name), 형식: String(info[v.doc_id]?.kind || ""), 메모: String(info[v.doc_id]?.memo || ""),
    조각: v.seq, 위치: String(v.loc || ""), 본문: String(v.body).slice(0, 2400),
  }));
}

/** 문서를 여는 임시 링크(하루 동안 유효) → { 파일ID: 링크 } */
async function docLinks(ids: string[]) {
  const out: Record<string, string> = {};
  const uniq = ids.filter((id, i) => ids.indexOf(id) === i);
  if (!uniq.length) return out;
  const docs = await run<any[]>(db.from("docs").select("id,name,kind,path").in("id", uniq));
  for (const d of docs) {
    // PDF·사진·텍스트는 브라우저에서 바로 보이고, 나머지는 원래 파일 이름으로 내려받는다
    const inline = ["PDF", "이미지", "텍스트"].indexOf(d.kind) >= 0;
    const { data } = await db.storage.from(CONFIG.BUCKET).createSignedUrl(d.path, CONFIG.LINK_HOURS * 3600, inline ? undefined : { download: d.name });
    if (data && data.signedUrl) out[d.id] = data.signedUrl;
  }
  return out;
}

async function actDocs() {
  const rows = await run<any[]>(db.from("docs").select("*").order("name"));
  const links = await docLinks(rows.filter((r) => r.status !== "올리는 중").map((r) => r.id));
  return {
    docs: rows.map((r) => ({ 파일ID: r.id, 파일명: r.name, 형식: r.kind, 크기: r.size, 수정일시: r.uploaded_at, 조각수: r.chunks || 0,
      읽은일시: r.read_at, 상태: r.status, 링크: links[r.id] || "", 메모: r.memo || "" })),
    maxMb: CONFIG.UPLOAD_MAX_MB,
  };
}

/** 읽기에 실패했거나 중간에 끊긴 문서를 다시 읽는다 (한 번에 100초까지) */
async function actReindex() {
  const started = Date.now();
  const rows = await run<any[]>(db.from("docs").select("*").neq("kind", "미지원"));
  let done = 0, errors = 0, pending = 0;
  for (const d of rows) {
    if (d.status === "완료" || d.status.indexOf("일부만") === 0) continue;
    if (Date.now() - started > 100000) { pending++; continue; }
    const st = await indexDoc(d);
    if (st === "완료") done++; else errors++;
  }
  return { done, errors, pending, ...(await actDocs()) };
}

async function actDeleteDoc(req: any) {
  const doc = (await run<any[]>(db.from("docs").select("id,path").eq("id", String(req.id))))[0];
  if (doc) {
    await db.storage.from(CONFIG.BUCKET).remove([doc.path]);
    await run(db.from("docs").delete().eq("id", doc.id));      // 조각은 함께 지워진다(on delete cascade)
  }
  return { deleted: req.id, ...(await actDocs()) };
}

/** 문서 본문을 앞에서부터 읽어 주기 좋게 돌려준다 */
async function actReadDoc(req: any) {
  const from = Math.max(1, Number(req.from) || 1);
  const rows = await run<any[]>(db.from("doc_chunks").select("seq,loc,body,name").eq("doc_id", String(req.id)).gte("seq", from).order("seq").limit(12));
  if (!rows.length) return { text: "", next: 0 };
  let text = "", next = 0;
  for (const r of rows) {
    if (text && text.length + r.body.length > CONFIG.DOC_READ_CHARS) { next = r.seq; break; }
    text += (text ? "\n" : "") + r.body;
  }
  if (!next && rows.length === 12) next = rows[11].seq + 1;
  return { name: rows[0].name, text, next };
}

// ───────────────────────── 할 일 · 아침 브리핑 ─────────────────────────
/** 할 일 = 유형 '할일' + 상태 '예정'. 대상일은 기한(없으면 빈칸). 완료는 상태를 '완료'로 바꾸는 것(변경이력에 남음) */
function todoGroups(all: any[], day: string) {
  const open = all.filter((r) => r.유형 === "할일" && r.상태 === "예정")
    .sort((a, b) => (a.대상일 || "9999").localeCompare(b.대상일 || "9999") || String(a.ID).localeCompare(String(b.ID)));
  return {
    late: open.filter((r) => r.대상일 && r.대상일 < day),
    due: open.filter((r) => r.대상일 === day),
    later: open.filter((r) => !r.대상일 || r.대상일 > day),
  };
}
const todoPick = (r: any) => ({ ID: r.ID, 제목: r.제목, 기한: r.대상일, 분류: r.분류, 내용: r.내용 });
const schPick = (r: any) => ({ ID: r.ID, 제목: r.제목, 시각: r.대상시각 });

async function actTodos() {
  const g = todoGroups((await getRecords({ type: "할일" })).filter((r) => r.상태 !== "삭제"), today());
  return { late: g.late.map(todoPick), due: g.due.map(todoPick), later: g.later.slice(0, 30).map(todoPick) };
}

async function actBrief() { return { brief: await buildBrief() }; }

const WX_KO: Record<number, string> = { 0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "안개", 51: "이슬비", 53: "이슬비", 55: "이슬비",
  56: "어는 비", 57: "어는 비", 61: "비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "어는 비", 71: "눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "소나기", 81: "소나기", 82: "강한 소나기", 85: "눈 소나기", 86: "눈 소나기", 95: "뇌우", 96: "뇌우", 99: "뇌우" };

function hourWord(h: number) { return h === 0 ? "밤 12시" : h < 12 ? "오전 " + h + "시" : h === 12 ? "낮 12시" : "오후 " + (h - 12) + "시"; }
function timeWord(hhmm: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "")); if (!m) return "";
  return hourWord(Number(m[1])) + (m[2] !== "00" ? " " + Number(m[2]) + "분" : "");
}

/** 무료 날씨(Open-Meteo). 실패하면 null — 브리핑은 날씨 없이도 나간다 */
async function getWeather() {
  const w = CONFIG.WEATHER;
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + w.lat + "&longitude=" + w.lon +
      "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&hourly=precipitation_probability&timezone=Asia%2FSeoul&forecast_days=1";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const nowH = kst().hour;
    let rainHour: number | null = null, rainP = 0;
    (j.hourly.time || []).forEach((t: string, i: number) => {
      const h = Number(String(t).slice(11, 13)), p = j.hourly.precipitation_probability[i] || 0;
      if (h >= nowH && p >= 50 && rainHour === null) { rainHour = h; rainP = p; }
    });
    const maxP = j.daily.precipitation_probability_max[0] || 0;
    const rain = rainHour !== null ? hourWord(rainHour) + "쯤 비 소식이 있습니다(" + rainP + "%)"
      : maxP >= 30 ? "비 올 확률은 최대 " + maxP + "%입니다" : "비 소식은 없습니다";
    return { 지역: w.name, 기온: Math.round(j.current.temperature_2m), 날씨: WX_KO[j.current.weather_code] || "",
      최고: Math.round(j.daily.temperature_2m_max[0]), 최저: Math.round(j.daily.temperature_2m_min[0]), 비: rain };
  } catch (_e) { return null; }
}

/** 오늘 브리핑: AI 없이 기록과 날씨만으로 만든다(무료·빠름) */
async function buildBrief() {
  const day = today(), h = kst().hour;
  const all = (await getRecords()).filter((r) => r.상태 !== "삭제");
  const g = todoGroups(all, day);
  const schedule = all.filter((r) => /일정/.test(r.유형) && r.상태 === "예정" && r.대상일 === day)
    .sort((a, b) => String(a.대상시각 || "99").localeCompare(String(b.대상시각 || "99")));
  const wx = await getWeather();
  const greet = h < 5 ? "늦은 밤입니다" : h < 11 ? "좋은 아침입니다" : h < 17 ? "안녕하세요" : h < 22 ? "좋은 저녁입니다" : "늦은 밤입니다";
  const label = dateLabel(day);

  const say = [greet + ", 카일님. " + label + "입니다."];
  const lines = ["■ " + label];
  if (wx) {
    say.push(wx.지역 + "은 지금 " + wx.기온 + "도, " + wx.날씨 + ". 최고 " + wx.최고 + "도, 최저 " + wx.최저 + "도이고 " + wx.비 + ".");
    lines.push("■ 날씨 · " + wx.지역, "• 지금 " + wx.기온 + "° " + wx.날씨 + " (최고 " + wx.최고 + "° / 최저 " + wx.최저 + "°)", "• " + wx.비);
  }
  const sch = (r: any) => (r.대상시각 ? timeWord(r.대상시각) + " " : "") + r.제목;
  if (schedule.length) {
    say.push("오늘 일정은 " + schedule.slice(0, 3).map(sch).join(", ") + (schedule.length > 3 ? " 외 " + (schedule.length - 3) + "건" : "") + "입니다.");
    lines.push("■ 오늘 일정", ...schedule.map((r) => "• " + (r.대상시각 ? r.대상시각 + " " : "") + r.제목));
  } else say.push("오늘 잡힌 일정은 없습니다.");
  if (g.due.length) {
    say.push("오늘 할 일은 " + g.due.slice(0, 3).map((r) => r.제목).join(", ") + (g.due.length > 3 ? " 외 " + (g.due.length - 3) + "가지" : "") + "입니다.");
  } else say.push("오늘까지 해야 할 일은 없습니다.");
  if (g.late.length) say.push("기한이 지난 일이 " + g.late.length + "개 있습니다.");
  if (g.late.length || g.due.length || g.later.length) {
    lines.push("■ 할 일");
    g.late.forEach((r) => lines.push("• [기한 지남 " + r.대상일.slice(5) + "] " + r.제목));
    g.due.forEach((r) => lines.push("• [오늘까지] " + r.제목));
    g.later.slice(0, 5).forEach((r) => lines.push("• " + (r.대상일 ? "[" + r.대상일.slice(5) + "까지] " : "") + r.제목));
  }
  return { greet, 오늘: day, 날짜: label, 날씨: wx, 일정: schedule.map(schPick),
    late: g.late.map(todoPick), due: g.due.map(todoPick), later: g.later.slice(0, 5).map(todoPick),
    speech: say.join(" "), detail: lines.join("\n") };
}

// ───────────────────────── 보고서 · 예약 작업 ─────────────────────────
/** 1분마다 자동 실행: 시간이 된 예약(아침 브리핑·밤 10시 보고서 포함)을 수행 */
async function runScheduler() {
  const now = new Date(), nowS = nowStr(now);
  const due: any[] = [];
  for (const t of await getTasks()) {
    if (t.활성 !== "Y") continue;
    if (!t.다음실행) { t.다음실행 = nextRun(t, now); await saveTaskRow(t); continue; }
    if (t.다음실행 > nowS) continue;
    // 실행하기 전에 다음 실행 시각부터 모두 적어 둔다 (오래 걸리는 작업이 다음 자동 실행과 겹쳐 두 번 돌지 않게)
    t.마지막실행 = nowS;
    if (t.반복 === "한번") { t.활성 = "N"; t.다음실행 = ""; }
    else t.다음실행 = nextRun(t, new Date(now.getTime() + 60000));
    await saveTaskRow(t);
    due.push(t);
  }
  let ran = 0;
  for (const t of due) {
    try { await runTask(t); ran++; }
    catch (e: any) { await saveReport({ 종류: "오류", 제목: t.이름 + " 실행 실패", 음성요약: "", 상세: String(e && e.message || e), 예약ID: t.ID }); }
  }
  return ran;
}

async function runTask(t: any) {
  if (t.요청 === "__DAILY__") return await buildDailyReport(today());
  if (t.요청 === "__BRIEF__") {
    const b = await buildBrief();
    return await saveReport({ 종류: "브리핑", 제목: b.날짜 + " 아침 브리핑", 음성요약: b.speech, 상세: b.detail, 예약ID: t.ID });
  }
  const plan = await makePlan(t.요청, []);
  plan.의도 = "질문";
  const a = await answer(t.요청, plan, []);
  return await saveReport({ 종류: "예약", 제목: t.이름, 음성요약: a.speech, 상세: a.detail, 예약ID: t.ID });
}

/** 오늘 하루 기록으로 저녁 보고서를 만든다 */
async function buildDailyReport(dateStr: string) {
  const all = (await getRecords()).filter((r) => r.상태 !== "삭제");
  const todays = all.filter((r) => r.대상일 === dateStr || String(r.입력일시).slice(0, 10) === dateStr);
  const upcoming = all.filter((r) => /일정/.test(r.유형) && r.상태 === "예정" && r.대상일 > dateStr && r.대상일 <= ymdAdd(dateStr, 7))
    .sort((a, b) => (a.대상일 + a.대상시각).localeCompare(b.대상일 + b.대상시각));
  const spend = todays.filter((r) => r.유형 === "지출" && typeof r.금액 === "number");
  const month = dateStr.slice(0, 7);
  const monthSpend = all.filter((r) => r.유형 === "지출" && typeof r.금액 === "number" && dayOf(r).slice(0, 7) === month)
    .reduce((s, r) => s + r.금액, 0);
  const byType: Record<string, number> = {};
  todays.forEach((r) => { byType[r.유형] = (byType[r.유형] || 0) + 1; });
  const stats: any = { 기록건수: todays.length, 유형별: byType, 오늘지출건수: spend.length,
    오늘지출합계: spend.reduce((s, r) => s + r.금액, 0), 이번달지출합계: monthSpend, 다가오는일정수: upcoming.length };
  const openTodos = todoGroups(all, dateStr);
  const todoList = openTodos.late.concat(openTodos.due, openTodos.later).slice(0, 15).map((r) => ({ 제목: r.제목, 기한: r.대상일 || "없음" }));
  stats.남은할일수 = openTodos.late.length + openTodos.due.length + openTodos.later.length;
  const title = dateLabel(dateStr) + " 하루 정리";

  if (!todays.length && !upcoming.length && !stats.남은할일수) {
    return await saveReport({ 종류: "일일", 제목: title,
      음성요약: "카일님, 오늘은 남기신 기록이 없습니다. 편안한 밤 보내세요.",
      상세: "• 오늘 기록 0건\n• 7일 안의 예정 일정 없음", 예약ID: DAILY_ID });
  }
  const pick = (r: any) => ({ ID: r.ID, 날짜: r.대상일, 시각: r.대상시각, 유형: r.유형, 분류: r.분류, 제목: r.제목, 내용: r.내용, 금액: r.금액, 인물: r.인물, 장소: r.장소 });
  const sys = [
    "너는 카일님의 개인 비서 Lobby다. 오늘 하루 기록으로 저녁 보고서를 쓴다.",
    "오늘: " + dateLabel(dateStr),
    "규칙:",
    "- 숫자는 [통계] 값을 그대로 쓴다. 기록에 없는 일은 지어내지 않는다.",
    '- 음성: 존댓말 3~4문장. "카일님, 오늘 하루 정리해 드립니다."로 시작하고, 가장 중요한 일 → 지출 → 내일 일정 순으로 짧게.',
    '- 상세: 아래 제목 순서로, 해당 내용이 없는 제목은 생략. 목록은 "• "로 시작. 금액은 12,000원 형식.',
    "  ■ 오늘 한 일 / ■ 지출 (오늘 합계, 이번 달 누적) / ■ 업무·특이점 / ■ 남은 할 일 ([남은할일] 기준, 기한 지난 것 먼저) / ■ 떠오른 아이디어 / ■ 다가오는 일정 (7일) / ■ Lobby의 한마디 (내일을 위한 짧은 제안 1줄)",
    '반드시 JSON만 출력: {"음성":"","상세":""}',
  ].join("\n");
  const payload = { 통계: stats, 오늘기록: todays.map(pick), 다가오는일정: upcoming.slice(0, 15).map(pick), 남은할일: todoList };
  const ans = extractJson(await callClaude(sys, JSON.stringify(payload), 1500));
  return await saveReport({ 종류: "일일", 제목: title, 음성요약: ans.음성 || "", 상세: ans.상세 || "", 예약ID: DAILY_ID });
}

async function saveReport(o: any) {
  const p = kst();
  const r = { ID: "R" + p.ymd.replace(/-/g, "") + p.hm.replace(":", "") + p.sec + Math.floor(Math.random() * 90 + 10),
    생성일시: p.ymd + " " + p.hm, 종류: o.종류 || "일일", 제목: o.제목 || "",
    음성요약: o.음성요약 || "", 상세: o.상세 || "", 읽음: "N", 예약ID: o.예약ID || "" };
  await run(db.from("reports").insert(toDb(r, REPORT_MAP)));
  return r;
}

async function getReports(limit: number) {
  const rows = await run<any[]>(db.from("reports").select("*").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit || 60));
  return rows.map((r) => toKo(r, REPORT_MAP));
}

async function actReports() { return { reports: await getReports(60), tasks: await getTasks() }; }

async function actReadReport(req: any) {
  const ids = (req.ids || [req.id]).map(String);
  await run(db.from("reports").update({ is_read: "Y" }).in("id", ids));
  return {};
}

async function actDeleteReport(req: any) {
  await run(db.from("reports").delete().eq("id", String(req.id)));
  return { deleted: req.id };
}

async function actRunDaily() { return { report: await buildDailyReport(today()) }; }

async function actSaveTask(req: any) {
  const t = normalizeTask(req.task || {});
  if (!t.요청) throw new Error("예약할 요청 내용이 비어 있습니다.");
  if (t.반복 === "매주" && !t.요일) throw new Error("매주 반복은 요일을 골라 주세요.");
  if (t.반복 === "한번" && !/^\d{4}-\d{2}-\d{2}$/.test(t.날짜)) throw new Error("한 번 실행할 날짜를 골라 주세요.");
  const old = (await getTasks()).filter((x) => x.ID === t.ID)[0];
  if (old && old.ID === DAILY_ID) t.요청 = "__DAILY__";
  if (old && old.ID === BRIEF_ID) t.요청 = "__BRIEF__";
  if (!t.ID) { const p = kst(); t.ID = "T" + p.ymd.replace(/-/g, "") + p.hm.replace(":", "") + p.sec; }
  if (old) t.마지막실행 = old.마지막실행;
  t.다음실행 = t.활성 === "Y" ? nextRun(t, new Date()) : "";
  await saveTaskRow(t);
  return { task: t, tasks: await getTasks() };
}

async function actDeleteTask(req: any) {
  if (req.id === DAILY_ID || req.id === BRIEF_ID) throw new Error("기본 예약은 지울 수 없습니다. 끄기만 할 수 있습니다.");
  await run(db.from("tasks").delete().eq("id", String(req.id)));
  return { tasks: await getTasks() };
}

function normalizeTask(x: any) {
  const days: any[] = Array.isArray(x.요일) ? x.요일 : String(x.요일 || "").split(/[,\s·/]+/);
  const t: any = {
    ID: String(x.ID || ""), 이름: String(x.이름 || "").slice(0, 30) || "예약 작업",
    반복: REPEATS.indexOf(x.반복) >= 0 ? x.반복 : "매일",
    요일: days.map((d) => String(d).trim().charAt(0)).filter((d) => WEEKDAYS.indexOf(d) >= 0)
      .sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(","),
    날짜: String(x.날짜 == null ? "" : x.날짜).trim(), 시각: normTime(x.시각) || "09:00",
    요청: String(x.요청 || "").trim(), 활성: x.활성 === "N" || x.활성 === false ? "N" : "Y",
    마지막실행: String(x.마지막실행 || ""), 다음실행: String(x.다음실행 || ""),
  };
  if (t.반복 !== "매주") t.요일 = "";
  if (t.반복 === "매일") t.날짜 = "";
  return t;
}

function describeTask(t: any) {
  const when = t.반복 === "매일" ? "매일" : t.반복 === "매주" ? "매주 " + t.요일.replace(/,/g, "·") + "요일"
    : t.반복 === "매월" ? "매월 " + t.날짜 + "일" : dateLabel(t.날짜);
  const [h, m] = t.시각.split(":").map(Number);
  const time = (h < 12 ? "오전 " : "오후 ") + ((h % 12) || 12) + "시" + (m ? " " + m + "분" : "");
  return when + " " + time + '에 "' + t.요청 + '"을(를) 수행합니다.';
}

async function getTasks() {
  const rows = await run<any[]>(db.from("tasks").select("*").order("id"));
  return rows.map((r) => toKo(r, TASK_MAP));
}

async function saveTaskRow(t: any) {
  await run(db.from("tasks").upsert(toDb(t, TASK_MAP)));
}

function nextRun(t: any, from: Date) {
  const nowS = nowStr(from);
  const d0 = nowS.slice(0, 10);
  const time = normTime(t.시각) || "09:00";
  if (t.반복 === "한번") { const c = String(t.날짜) + " " + time; return c > nowS ? c : ""; }
  const days = String(t.요일 || "").split(",").filter(Boolean);
  for (let i = 0; i < 400; i++) {
    const d = ymdAdd(d0, i);
    let ok = t.반복 === "매일";
    if (t.반복 === "매주") ok = days.indexOf(weekdayOf(d)) >= 0;
    if (t.반복 === "매월") { const want = Number(t.날짜) || 1; ok = Number(d.slice(8)) === Math.min(want, lastDom(d)); }
    if (ok) { const c = d + " " + time; if (c > nowS) return c; }
  }
  return "";
}

function normTime(s: any) {
  const m = String(s || "").match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?/);
  if (!m) return "";
  let h = Math.min(23, Number(m[1]));
  const mi = Math.min(59, Number(m[2] || 0));
  if (h === 12 && /오전|새벽|밤/.test(String(s))) h = 0;          // "밤 12시"·"오전 12시"는 자정(00시)
  else if (h < 12 && (/오후|저녁/.test(String(s)) || (/밤/.test(String(s)) && h >= 6))) h += 12;   // "밤 1~5시"는 새벽이라 그대로 둔다
  return z2(h) + ":" + z2(mi);
}

// ───────────────────────── 일정 알림 ─────────────────────────
// 기록의 알림(몇 분 전)과 대상일·대상시각으로 "다음 알림 시각(alarm_at)"을 계산해 둔다.
// 앱 화면이 켜져 있으면 화면이 직접 소리를 내고, 휴대폰 알림을 켜 둔 기기에는 1분마다 도는 자동 실행이 알림을 보낸다.

/** 알림 값 정리: "" = 알림 없음, "0" = 정각, "10" = 10분 전 … (최대 7일 전) */
function alarmVal(v: any) {
  if (v === null || v === undefined || String(v).trim() === "") return "";
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, "")));
  return isFinite(n) && n >= 0 ? String(Math.min(n, 7 * 1440)) : "";
}
const kstMs = (ymd: string, hm: string) => Date.parse(ymd + "T" + hm + ":00+09:00");

/** 다음에 울릴 시각("yyyy-MM-dd HH:mm"). 알림이 없거나, 예정이 아니거나, 이미 지난 일이면 "" */
function alarmAtOf(r: any, from = new Date()) {
  if (r.상태 !== "예정" || alarmVal(r.알림) === "" || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.대상일 || ""))) return "";
  const ev = kstMs(r.대상일, normTime(r.대상시각) || CONFIG.ALARM_ALLDAY_TIME);
  if (isNaN(ev) || ev <= from.getTime()) return "";
  const at = ev - Number(alarmVal(r.알림)) * 60000;
  return nowStr(new Date(at > from.getTime() ? at : ev));     // "10분 전"이 이미 지났으면 일정 시각 정각에 울린다
}

const alarmPick = (r: any) => ({ ID: r.ID, 제목: r.제목, 유형: r.유형, 대상일: r.대상일, 대상시각: r.대상시각, 장소: r.장소, 알림: r.알림, 알림시각: r.알림시각 });

/** 알림 칸이 없는 DB(아직 alarms.sql을 실행하지 않음)에서 나는 오류를 알아듣기 쉽게 바꾼다 */
async function alarmSafe<T>(p: Promise<T>) {
  try { return await p; } catch (e: any) {
    if (/alarm/.test(String(e && e.message))) throw new Error("알림 기능용 표 업데이트가 필요합니다. Supabase SQL Editor에서 supabase/migrations/20261007000000_alarms.sql을 한 번 실행해 주세요.");
    throw e;
  }
}

/** 화면이 미리 받아 두는 알림 목록: 조금 전(놓친 것)부터 36시간 뒤까지 */
async function actAlarms() {
  const from = nowStr(new Date(Date.now() - CONFIG.ALARM_GRACE_MIN * 60000)), to = nowStr(new Date(Date.now() + 36 * 3600000));
  try {
    const rows = await run<any[]>(db.from("records").select("*").eq("status", "예정").neq("alarm_at", "")
      .gte("alarm_at", from).lte("alarm_at", to).order("alarm_at").limit(100));
    return { alarms: rows.map((r) => alarmPick(toKo(r, REC_MAP))), now: nowStr() };
  } catch (e: any) {
    if (/alarm/.test(String(e && e.message))) return { alarms: [], needsUpdate: true };
    throw e;
  }
}

/** 화면에서 알림을 확인(끄기)하거나 n분 뒤 다시 알림 */
async function actAlarmAck(req: any) {
  const id = String(req.id || "");
  if (!id) throw new Error("알림 기록 ID가 없습니다.");
  const n = Math.max(0, Math.min(180, parseInt(req.snooze, 10) || 0));
  const next = n ? nowStr(new Date(Date.now() + n * 60000)) : "";
  let q = db.from("records").update({ alarm_at: next }).eq("id", id);
  if (!n && req.at) q = q.eq("alarm_at", String(req.at));      // 그사이 다시 맞춰진 알림은 지우지 않는다
  await run(q);
  return { alarm_at: next };
}

/** 알림 문구: "10분 뒤 · 오후 3시" */
function alarmWhen(a: any, now = Date.now()) {
  const ev = kstMs(a.대상일, normTime(a.대상시각) || CONFIG.ALARM_ALLDAY_TIME);
  const m = Math.round((ev - now) / 60000);
  const rel = m >= 1440 ? Math.round(m / 1440) + "일 뒤" : m >= 60 ? Math.floor(m / 60) + "시간" + (m % 60 ? " " + (m % 60) + "분" : "") + " 뒤"
    : m >= 1 ? m + "분 뒤" : m > -2 ? "지금" : (-m) + "분 지남";
  const day = a.대상일 === today() ? "오늘" : a.대상일 === ymdAdd(today(), 1) ? "내일" : dateLabel(a.대상일);
  return { rel, minutes: m, text: rel + " · " + day + " " + (a.대상시각 ? timeWord(a.대상시각) : "종일") };
}

/** 1분마다: 시각이 된 알림을 휴대폰 알림으로 보낸다 */
async function runAlarms() {
  const nowS = nowStr();
  const due = await run<any[]>(db.from("records").select("*").neq("alarm_at", "").lte("alarm_at", nowS).order("alarm_at").limit(50));
  if (!due.length) return 0;
  const grace = nowStr(new Date(Date.now() - CONFIG.ALARM_GRACE_MIN * 60000));
  const subs = await run<any[]>(db.from("push_subs").select("*"));
  let sent = 0;
  for (const row of due) {
    const r = toKo(row, REC_MAP);
    if (r.상태 === "예정" && r.알림시각 >= grace) {
      // 받을 기기가 없거나 보내지 못했으면 지우지 않고 남겨 둔다 → 앱을 열면 화면이 대신 울린다
      if (!subs.length) continue;
      const w = alarmWhen(r);
      const res = await pushAll(subs, { title: "🔔 " + r.제목, body: w.text + (r.장소 ? " · " + r.장소 : ""), tag: "alarm-" + r.ID, alarm: alarmPick(r) });
      if (!res.sent) continue;
      sent++;
    }
    await run(db.from("records").update({ alarm_at: "" }).eq("id", row.id).eq("alarm_at", row.alarm_at));
  }
  return sent;
}

// ───────────────────────── 휴대폰 알림 (Web Push) ─────────────────────────
// 표준 Web Push(VAPID + aes128gcm, RFC 8291/8292)를 Deno 기본 암호화(WebCrypto)로 직접 보낸다. 별도 라이브러리·외부 서비스가 필요 없다.
const b64u = (b: Uint8Array) => encodeBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); return decodeBase64(t + "===".slice((t.length + 3) % 4)); };
const utf8 = (s: string) => new TextEncoder().encode(s);
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0; parts.forEach((p) => { out.set(p, i); i += p.length; });
  return out;
}

let vapidCache: { pub: string; key: CryptoKey } | null = null;
/** 서명 키: 비밀 값(VAPID_*)이 있으면 그것을, 없으면 처음 한 번 만들어 app_keys 표에 보관한 키를 쓴다 */
async function vapid() {
  if (vapidCache) return vapidCache;
  let pub = Deno.env.get("VAPID_PUBLIC_KEY") || "", priv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
  if (!pub || !priv) {
    const names = ["vapid_public", "vapid_private"];
    const load = async () => Object.fromEntries((await run<any[]>(db.from("app_keys").select("key,value").in("key", names))).map((r) => [r.key, r.value]));
    let k: any = await load();
    if (!k.vapid_public || !k.vapid_private) {
      if (k.vapid_public || k.vapid_private) await run(db.from("app_keys").delete().in("key", names));   // 한쪽만 남은 키는 버리고 새로 만든다
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      await run(db.from("app_keys").upsert([{ key: "vapid_public", value: b64u(raw) }, { key: "vapid_private", value: String(jwk.d) }], { onConflict: "key", ignoreDuplicates: true }));
      k = await load();                            // 동시에 만든 요청이 있었으면 먼저 저장된 쪽을 쓴다
    }
    pub = k.vapid_public; priv = k.vapid_private;
  }
  const p = unb64u(pub);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: priv, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return vapidCache = { pub, key };
}

/** VAPID 인증 헤더 (ES256 JWT) */
async function vapidAuth(endpoint: string) {
  const v = await vapid();
  const part = (o: any) => b64u(utf8(JSON.stringify(o)));
  const unsigned = part({ typ: "JWT", alg: "ES256" }) + "." + part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONFIG.PUSH_CONTACT });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, utf8(unsigned)));
  return "vapid t=" + unsigned + "." + b64u(sig) + ", k=" + v.pub;
}

/** 알림 내용 암호화 (aes128gcm, RFC 8291). salt·서버 키를 넘기면 고정값으로 계산(시험용) */
async function encryptPush(p256dh: string, auth: string, text: string, fixed?: { salt: Uint8Array<ArrayBuffer>; pair: CryptoKeyPair }) {
  const uaPub = unb64u(p256dh), secret = unb64u(auth);
  const pair = fixed ? fixed.pair : await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));
  const hkdf = async (salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
  const ikm = await hkdf(secret, shared, concat(utf8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(utf8(text), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  return concat(head, asPub, body);
}

/** 한 기기에 보내기. 기기가 구독을 끊었으면(404·410) 목록에서 지운다 */
async function sendPush(sub: any, payload: any) {
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { Authorization: await vapidAuth(sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" },
      body: await encryptPush(sub.p256dh, sub.auth, JSON.stringify(payload)),
    });
    if (res.ok) return { ok: true, status: res.status, msg: "" };
    const msg = (await res.text()).slice(0, 200);
    if (res.status === 404 || res.status === 410) await run(db.from("push_subs").delete().eq("endpoint", sub.endpoint));
    return { ok: false, status: res.status, msg };
  } catch (e: any) { return { ok: false, status: 0, msg: String(e && e.message || e) }; }
}
async function pushAll(subs: any[], payload: any) {
  const results = await Promise.all(subs.map((s) => sendPush(s, payload)));
  results.forEach((r, i) => { if (!r.ok) console.error("휴대폰 알림 실패", r.status, r.msg, String(subs[i].endpoint).slice(0, 60)); });
  return { sent: results.filter((r) => r.ok).length, results };
}

async function actPushKey() {
  return { publicKey: (await vapid()).pub, devices: (await run<any[]>(db.from("push_subs").select("endpoint"))).length };
}
async function actPushSub(req: any) {
  const s = req.sub || {}, keys = s.keys || {};
  if (!/^https:\/\//.test(String(s.endpoint || "")) || !keys.p256dh || !keys.auth) throw new Error("알림 구독 정보가 올바르지 않습니다.");
  await run(db.from("push_subs").upsert({ endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth, created_at: nowStr(), ua: String(req.ua || "").slice(0, 160) }));
  return { devices: (await run<any[]>(db.from("push_subs").select("endpoint"))).length };
}
async function actPushUnsub(req: any) {
  if (req.endpoint) await run(db.from("push_subs").delete().eq("endpoint", String(req.endpoint)));
  return {};
}
async function actPushTest(req: any) {
  let q = db.from("push_subs").select("*");
  if (req.endpoint) q = q.eq("endpoint", String(req.endpoint));
  const subs = await run<any[]>(q);
  if (!subs.length) throw new Error("알림을 받을 기기가 등록되어 있지 않습니다. 설정에서 '휴대폰 알림 받기'를 먼저 눌러 주세요.");
  const r = await pushAll(subs, { title: "🔔 Lobby2 알림 시험", body: "카일님, 휴대폰 알림이 잘 도착했습니다.", tag: "alarm-test" });
  const fail = r.results.filter((x) => !x.ok)[0];
  return { sent: r.sent, total: subs.length, error: fail ? "(" + fail.status + ") " + fail.msg : "" };
}

// ───────────────────────── 수정&삭제 탭 ─────────────────────────
async function actList(req: any) {
  const deleted = !!req.deleted;
  let rows = (await getRecords()).filter((r) => deleted ? r.상태 === "삭제" : r.상태 !== "삭제");
  if (req.from || req.to) {
    const f = req.from || "0000-00-00", t = req.to || "9999-99-99";
    rows = rows.filter((r) => {
      const d1 = dayOf(r), d2 = String(r.입력일시).slice(0, 10);
      return (d1 >= f && d1 <= t) || (d2 >= f && d2 <= t);
    });
  }
  if (req.type) rows = rows.filter((r) => r.유형 === req.type);
  if (req.q) {
    const k = String(req.q).toLowerCase();
    rows = rows.filter((r) => [r.제목, r.내용, r.태그, r.인물, r.장소, r.원문, r.분류].join(" ").toLowerCase().indexOf(k) >= 0);
  }
  rows.sort((a, b) => String(b.입력일시 + b.ID).localeCompare(String(a.입력일시 + a.ID)));
  return { rows: rows.slice(0, 200), total: rows.length };
}

async function getRecord(id: any) {
  if (!id) throw new Error("기록 ID가 없습니다.");
  const row = (await run<any[]>(db.from("records").select("*").eq("id", String(id))))[0];
  if (!row) throw new Error("해당 기록을 찾지 못했습니다: " + id);
  return toKo(row, REC_MAP);
}

async function actUpdate(req: any) {
  const fields = req.fields || {};
  const cur = await getRecord(req.id);
  const now = nowStr();
  const hist: any[] = [], patch: any = {};
  EDITABLE.forEach((k) => {
    if (!(k in fields)) return;
    let v = fields[k];
    if (k === "금액") v = toNum(v);
    else if (k === "알림") v = alarmVal(v);
    else if (k === "인물" || k === "태그") v = listStr(v);
    else v = mask(String(v == null ? "" : v));
    if (k === "유형" && TYPES.indexOf(v) < 0) return;
    if (k === "상태" && STATES.indexOf(v) < 0) return;
    const old = cur[k];
    if (String(old ?? "") !== String(v ?? "")) {
      patch[COL[k]] = v; cur[k] = v;
      hist.push({ at: now, record_id: String(req.id), field: k, old_value: String(old ?? ""), new_value: String(v ?? ""), via: "화면" });
    }
  });
  if (!hist.length) return { changed: 0 };
  // 날짜·시각·상태·알림이 바뀌면 다음 알림 시각을 다시 계산한다 (완료·취소하면 알림도 꺼진다)
  if (["대상일", "대상시각", "상태", "알림"].some((k) => COL[k] in patch)) {
    const at = alarmAtOf(cur);
    if (at !== cur.알림시각) { patch.alarm_at = at; cur.알림시각 = at; }
  }
  patch.updated_at = now; cur.수정일시 = now;
  await alarmSafe(run(db.from("records").update(patch).eq("id", String(req.id))));
  await run(db.from("history").insert(hist));
  return { changed: hist.length, row: cur };
}

async function actDelete(req: any) {
  const cur = await getRecord(req.id);
  if (cur.상태 === "삭제") return { already: true };
  const now = nowStr();
  await run(db.from("records").update({ status: "삭제", deleted_at: now, ...(cur.알림시각 ? { alarm_at: "" } : {}) }).eq("id", String(req.id)));
  await run(db.from("history").insert({ at: now, record_id: String(req.id), field: "상태", old_value: cur.상태, new_value: "삭제", via: "화면" }));
  return { deleted: req.id };
}

async function actRestore(req: any) {
  const cur = await getRecord(req.id);
  const last = (await run<any[]>(db.from("history").select("old_value").eq("record_id", String(req.id)).eq("field", "상태").eq("new_value", "삭제")
    .order("id", { ascending: false }).limit(1)))[0];
  const prev = (last && last.old_value) || "정상";
  const now = nowStr();
  const at = alarmAtOf({ ...cur, 상태: prev });
  await run(db.from("records").update({ status: prev, deleted_at: "", ...(at !== cur.알림시각 ? { alarm_at: at } : {}) }).eq("id", String(req.id)));
  await run(db.from("history").insert({ at: now, record_id: String(req.id), field: "상태", old_value: "삭제", new_value: prev, via: "복구" }));
  return { restored: req.id, 상태: prev };
}

/** 매일 새벽 4시: 삭제 후 30일 지난 기록을 휴지통(trash) 표로 옮김 */
async function purgeTrash() {
  const limit = nowStr(new Date(Date.now() - CONFIG.TRASH_DAYS * 86400000));
  const rows = await run<any[]>(db.from("records").select("*").eq("status", "삭제").neq("deleted_at", "").lt("deleted_at", limit).limit(1000));
  if (!rows.length) return;
  await run(db.from("trash").upsert(rows));
  await run(db.from("records").delete().in("id", rows.map((r) => r.id)));
}

// ───────────────────────── Claude 사용 요금(예상) ─────────────────────────
// Claude API가 응답마다 알려 주는 토큰 수에 단가를 곱해 usage 표에 날짜·모델별로 쌓는다.
// 실제 청구액(console.anthropic.com)과는 환율·단가 차이로 조금 다를 수 있는 "예상 금액"이다.
function costKrw(model: string, inTok: number, outTok: number) {
  const prices = CONFIG.PRICE_PER_MTOK;
  const key = prices[model] ? model : Object.keys(prices).filter((k) => String(model).indexOf(k) === 0)[0];
  const p = prices[key] || prices["claude-sonnet-4-5"];
  return (inTok * p[0] + outTok * p[1]) / 1e6 * CONFIG.KRW_PER_USD;
}

async function recordUsage(model: string, usage: any) {
  if (!usage) return;
  try {
    const day = today();
    const inTok = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
    const outTok = Number(usage.output_tokens || 0);
    const cur = (await run<any[]>(db.from("usage").select("*").eq("day", day).eq("model", model)))[0] || { calls: 0, in_tokens: 0, out_tokens: 0 };
    const inAll = Number(cur.in_tokens) + inTok, outAll = Number(cur.out_tokens) + outTok;
    await run(db.from("usage").upsert({ day, model, calls: Number(cur.calls) + 1, in_tokens: inAll, out_tokens: outAll, cost_krw: Math.round(costKrw(model, inAll, outAll)) }));
  } catch (_e) { /* 요금 기록이 실패해도 답변은 계속 */ }
}

async function usageSummary() {
  try {
    const o = { 오늘: 0, 이번달: 0, 누적: 0, 오늘호출: 0, 월예산: CONFIG.MONTH_BUDGET_KRW, 기준: "예상" };
    const day = today(), month = day.slice(0, 7);
    (await fetchAll(() => db.from("usage").select("day,calls,cost_krw").order("day"))).forEach((r) => {
      const c = Number(r.cost_krw) || 0;
      o.누적 += c;
      if (String(r.day).slice(0, 7) === month) o.이번달 += c;
      if (r.day === day) { o.오늘 += c; o.오늘호출 += Number(r.calls) || 0; }
    });
    return o;
  } catch (_e) { return null; }
}

// ───────────────────────── 공통 유틸 ─────────────────────────
async function getRecords(opt: { type?: string } = {}) {
  const rows = await fetchAll(() => {
    let q = db.from("records").select("*").order("id");
    if (opt.type) q = q.eq("type", opt.type);
    return q;
  });
  return rows.map((r) => toKo(r, REC_MAP));
}

function dayOf(r: any) { return r.대상일 || String(r.입력일시).slice(0, 10); }

async function recent(n: number) {
  const rows = await run<any[]>(db.from("records").select("*").neq("status", "삭제").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(n));
  return rows.map((r) => toKo(r, REC_MAP));
}

async function getCategories() {
  const rows = await run<any[]>(db.from("categories").select("name,description").order("added").order("name"));
  return rows.map((r) => ({ name: String(r.name).trim(), desc: String(r.description) }));
}

async function getProfile() {
  const o: Record<string, string> = {};
  (await run<any[]>(db.from("profile").select("key,value"))).forEach((r) => { o[r.key] = r.value; });
  return o;
}

function toNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? Math.round(v) : null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return String(v).replace(/[^\d]/g, "") === "" || !isFinite(n) ? null : Math.round(n);
}

function listStr(v: any) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).join(", ");
  return String(v || "").trim();
}

/** 카드번호·계좌번호처럼 보이는 긴 숫자열 가리기 */
function mask(s: any) {
  return String(s)
    .replace(/\b(\d{4})[-\s]?(\d{4})[-\s]?(\d{4})[-\s]?(\d{4})\b/g, "$1-****-****-****")
    .replace(/\b\d{2,6}-\d{2,6}-\d{4,8}\b/g, (m) => m.slice(0, 3) + "***");
}

/** user는 문자열 또는 content 배열(PDF·사진 등). cut은 답이 길어 중간에 잘렸는지 여부 */
async function callClaudeFull(system: string, user: any, maxTokens: number) {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new Error("서버에 ANTHROPIC_API_KEY가 등록되어 있지 않습니다.");
  let res;
  try {
    res = await anthropic.messages.create({ model: CONFIG.MODEL, max_tokens: maxTokens || 1500, system, messages: [{ role: "user", content: user }] });
  } catch (e: any) {
    if (e instanceof Anthropic.APIError) throw new Error("Claude API 오류(" + e.status + "): " + e.message);
    throw e;
  }
  await recordUsage(CONFIG.MODEL, res.usage);
  const text = res.content.map((c: any) => c.type === "text" ? c.text : "").join("");
  return { text, cut: res.stop_reason === "max_tokens" };
}
async function callClaude(system: string, user: any, maxTokens: number) {
  return (await callClaudeFull(system, user, maxTokens)).text;
}

function extractJson(text: string) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = m ? m[1] : String(text);
  const i = s.search(/[\[{]/);
  const j = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (i < 0 || j < i) throw new Error("AI 응답을 해석하지 못했습니다. 다시 말씀해 주세요.");
  return JSON.parse(s.slice(i, j + 1));
}
