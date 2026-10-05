# Lobby2

말로 기록하고, 말로 묻고, 올려 둔 문서를 읽고, 밤마다 보고하는 카일님의 개인 비서 (PWA)

기존 Lobby(구글 시트 + Apps Script)와 사용 방식은 같고, 데이터가 쌓이는 곳만 Supabase로 바꾼 버전입니다.

- 화면: `index.html` (GitHub Pages)
- 서버: `supabase/functions/api/index.ts` (Supabase Edge Function)
- 데이터: Supabase Postgres (`supabase/migrations/`), 문서 파일은 Supabase Storage의 `docs` 보관함

## 기능

- 대화 탭: 기록·질문·예약을 Lobby가 알아서 구분
- 호출어: 상단 "호출"을 켜 두면 "안녕 로비", "로비야"로 불러서 대화 (앱 화면이 켜져 있는 동안)
- 문서: 문서 탭에서 PDF·워드(docx)·엑셀·파워포인트(pptx)·사진·텍스트를 올리면 바로 읽어 두고, 물으면 찾아서 보여 주고 읽어 줌
- 할 일: "~해야 돼"라고 말하면 할 일로 저장되고, 대화 탭의 체크박스로 완료 처리
- 브리핑: "오늘 브리핑 해 줘" 또는 매일 아침 7:30 자동 — 날씨(Open-Meteo)·오늘 일정·할 일을 AI 없이 모아서 알려 줌
- 보고: 매일 밤 10시 하루 정리 보고서, 원하는 시각에 도는 예약 작업

## 설치 순서

1. Supabase 프로젝트 생성 (지역: Northeast Asia / Seoul)
2. 표 만들기: 대시보드 > SQL Editor에 `supabase/migrations/20261005000000_init.sql` 내용을 붙여넣고 실행
3. 서버 배포: `supabase functions deploy api` (설정은 `supabase/config.toml`)
4. 비밀 값 등록 (대시보드 > Edge Functions > Secrets): `ANTHROPIC_API_KEY`, `APP_PIN`, `CRON_SECRET`
5. 자동 실행 등록: `supabase/cron.sql`의 두 자리(`<PROJECT_REF>`, `<CRON_SECRET>`)를 채워 SQL Editor에서 실행
6. 앱 설정(톱니바퀴)에 서버 주소 `https://<PROJECT_REF>.supabase.co/functions/v1/api`와 접속 암호 입력

API 키·접속 암호는 Supabase의 비밀 값에만 저장하며, 이 저장소에는 올리지 않습니다.
