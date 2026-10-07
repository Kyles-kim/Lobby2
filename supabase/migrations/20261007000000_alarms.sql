-- Lobby2 일정 알림(소리) 기능
-- 이미 init.sql을 실행해 둔 프로젝트에서 Supabase 대시보드 > SQL Editor에 붙여넣고 한 번 실행한다. (여러 번 실행해도 안전)

-- 기록마다 알림 설정
--  alarm    : 몇 분 전에 알릴지 ("0"=정각, "10"=10분 전, "60"=1시간 전, "1440"=하루 전). 빈칸이면 알림 없음
--  alarm_at : 다음에 울릴 시각("2026-10-08 14:50", 한국 시간). 울리고 나면 빈칸이 된다
alter table records add column if not exists alarm text not null default '';
alter table records add column if not exists alarm_at text not null default '';
alter table trash add column if not exists alarm text not null default '';
alter table trash add column if not exists alarm_at text not null default '';
create index if not exists records_alarm_at on records (alarm_at) where alarm_at <> '';

-- 휴대폰 알림(앱이 꺼져 있어도 오는 알림)을 받을 기기 목록
create table if not exists push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  created_at text not null default '',
  ua text not null default ''
);

-- 서버가 쓰는 열쇠 보관함 (휴대폰 알림 서명용 VAPID 키를 서버가 처음 한 번 만들어 둔다)
create table if not exists app_keys (
  key text primary key,
  value text not null default ''
);

alter table push_subs enable row level security;
alter table app_keys enable row level security;

-- 이미 등록해 둔 앞으로의 일정(시각이 있는 일정·업무일정)은 10분 전 알림을 켜 둔다
update records
set alarm = '10',
    alarm_at = case   -- 10분 전이 이미 지났으면 일정 시각 정각에 울린다
      when (target_date || ' ' || target_time)::timestamp - interval '10 minutes' > now() at time zone 'Asia/Seoul'
        then to_char((target_date || ' ' || target_time)::timestamp - interval '10 minutes', 'YYYY-MM-DD HH24:MI')
      else target_date || ' ' || target_time end
where type in ('일정', '업무일정') and status = '예정' and alarm = ''
  and target_date ~ '^\d{4}-\d{2}-\d{2}$' and target_time ~ '^\d{2}:\d{2}$'
  and (target_date || ' ' || target_time)::timestamp > now() at time zone 'Asia/Seoul';
