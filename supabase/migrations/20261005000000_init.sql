-- Lobby2 초기 테이블
-- 날짜·시각 칸은 한국 시간 글자("2026-10-05", "2026-10-05 22:00", "07:30")로 저장한다.
-- 표 편집 화면에서 그대로 읽히고, 빈 값("기한 없음")을 그대로 둘 수 있다.
-- 모든 표는 RLS를 켜고 정책을 두지 않는다 → 서버(Edge Function)의 service role 키로만 읽고 쓴다.

create table if not exists records (
  id text primary key,                 -- 20261005-001
  created_at text not null,            -- 입력일시
  target_date text not null default '',-- 대상일 (할일은 기한, 없으면 빈칸)
  target_time text not null default '',-- 대상시각
  type text not null,                  -- 유형
  category text not null,              -- 분류
  title text not null default '',
  content text not null default '',
  amount bigint,                       -- 금액(원)
  people text not null default '',
  place text not null default '',
  tags text not null default '',
  status text not null default '정상', -- 정상·예정·완료·취소·삭제
  raw text not null default '',        -- 말씀하신 원문
  updated_at text not null default '',
  deleted_at text not null default ''
);
create index if not exists records_target_date on records (target_date);
create index if not exists records_status on records (status);

-- 삭제 후 30일이 지난 기록이 옮겨지는 곳
create table if not exists trash (like records including defaults);
alter table trash add primary key (id);

create table if not exists profile (
  key text primary key,
  value text not null default '',
  updated text not null default ''
);

create table if not exists categories (
  name text primary key,
  description text not null default '',
  added text not null default ''
);

create table if not exists chat_log (
  id bigint generated always as identity primary key,
  at text not null,
  question text not null default '',
  plan jsonb,
  speech text not null default '',
  note text not null default ''
);

create table if not exists history (
  id bigint generated always as identity primary key,
  at text not null,
  record_id text not null,
  field text not null,
  old_value text not null default '',
  new_value text not null default '',
  via text not null default ''
);
create index if not exists history_record on history (record_id);

create table if not exists docs (
  id uuid primary key default gen_random_uuid(),
  name text not null,                  -- 올린 파일 이름
  kind text not null default '',       -- PDF·워드·엑셀·파워포인트·이미지·텍스트·미지원
  path text not null,                  -- 저장소(docs 버킷) 안의 경로
  size bigint not null default 0,
  uploaded_at text not null default '',
  chunks integer not null default 0,
  read_at text not null default '',
  status text not null default '읽는 중'
);

create table if not exists doc_chunks (
  id bigint generated always as identity primary key,
  doc_id uuid not null references docs (id) on delete cascade,
  name text not null,
  seq integer not null,
  loc text not null default '',
  body text not null
);
create index if not exists doc_chunks_doc on doc_chunks (doc_id, seq);

create table if not exists reports (
  id text primary key,
  created_at text not null,
  kind text not null default '일일',   -- 일일·브리핑·예약·오류
  title text not null default '',
  speech text not null default '',
  detail text not null default '',
  is_read text not null default 'N',
  task_id text not null default ''
);

create table if not exists tasks (
  id text primary key,
  name text not null default '',
  repeat text not null default '매일', -- 매일·매주·매월·한번
  weekdays text not null default '',   -- "월,수"
  date text not null default '',       -- 매월이면 일자, 한번이면 yyyy-MM-dd
  time text not null default '09:00',
  request text not null default '',
  active text not null default 'Y',
  last_run text not null default '',
  next_run text not null default ''
);

create table if not exists usage (
  day text not null,
  model text not null,
  calls integer not null default 0,
  in_tokens bigint not null default 0,
  out_tokens bigint not null default 0,
  cost_krw integer not null default 0,
  primary key (day, model)
);

alter table records enable row level security;
alter table trash enable row level security;
alter table profile enable row level security;
alter table categories enable row level security;
alter table chat_log enable row level security;
alter table history enable row level security;
alter table docs enable row level security;
alter table doc_chunks enable row level security;
alter table reports enable row level security;
alter table tasks enable row level security;
alter table usage enable row level security;

-- 기본 분류
insert into categories (name, description, added) values
  ('차량', '정비·주유·보험·세차', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('생활', '장보기·생활용품·공과금', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('미용/자기관리', '이발·운동·자기계발', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('외식/모임', '외식·친구·동창 모임', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('가족행사', '생일·기념일·가족 모임', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('여가/취미', '골프·영화·취미 활동', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('여행', '국내외 여행·숙박', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('업무', '회사 일정·거래처·생산', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('재테크', '주식·저축·투자', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')),
  ('앱개발', '앱 아이디어·개발 작업', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'))
on conflict (name) do nothing;

-- 기본 예약: 아침 브리핑, 오늘의 보고서 (다음 실행 시각은 서버가 첫 실행 때 채운다)
insert into tasks (id, name, repeat, time, request) values
  ('BRIEF', '아침 브리핑', '매일', '07:30', '__BRIEF__'),
  ('DAILY', '오늘의 보고서', '매일', '22:00', '__DAILY__')
on conflict (id) do nothing;

-- 문서 파일 보관함 (비공개, 파일당 50MB)
insert into storage.buckets (id, name, public, file_size_limit)
values ('docs', 'docs', false, 52428800)
on conflict (id) do nothing;
