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
  - 도면: 파일 이름·메모에 "도면"이 있거나 치수 숫자 위주의 PDF는 Claude가 그림으로 보고 표제란(품번·재질·적용 원료)·치수("뷰·부분 - 치수: 값 공차")·주석을 정리해 둠
  - 제품사진: 사진의 종류(제품사진·도면·문서)를 판별해 형태·색상·각인까지 설명으로 남기고, 큰 사진은 올리기 전에 자동으로 줄임
  - 품번·메모: 올릴 때(또는 나중에 문서 카드에서) "CR-747 제품사진"처럼 붙여 두면 파일 이름이 IMG_1234.jpg여도 그 말로 찾음
  - 미리보기: 답변에 근거가 된 도면 쪽·사진이 바로 보이고, 누르면 원본이 크게 열림
- 할 일: "~해야 돼"라고 말하면 할 일로 저장되고, 대화 탭의 체크박스로 완료 처리
- 브리핑: "오늘 브리핑 해 줘" 또는 매일 아침 7:30 자동 — 날씨(Open-Meteo)·오늘 일정·할 일을 AI 없이 모아서 알려 줌
- 보고: 매일 밤 10시 하루 정리 보고서, 원하는 시각에 도는 예약 작업
- 일정 알림: "내일 3시 미라셀 미팅, 30분 전에 알려 줘", "6시에 약 먹으라고 알려 줘"처럼 말하면 그 시각에 소리·진동·음성으로 알림
  - 시각이 있는 일정·업무일정은 말하지 않아도 기본 10분 전 알림(설정에서 변경), 할일은 그 시각 정각
  - 앱 화면이 켜져 있으면 화면이 직접 울리고(차임벨·마림바·디지털 알람 중 선택), "5분 뒤 다시"로 미룰 수 있음
  - 설정 > "휴대폰 알림 받기"를 켜 두면 앱을 닫았거나 화면이 잠겨 있어도 휴대폰 알림이 옴 (아이폰은 Safari에서 "홈 화면에 추가"로 설치한 앱에서만 가능, iOS 16.4 이상)
  - 대화 탭의 "다가오는 알림" 카드에서 확인·끄기, 수정 탭에서 기록별로 알림 시점 변경

## 설치 순서

1. Supabase 프로젝트 생성 (지역: Northeast Asia / Seoul)
2. 표 만들기: 대시보드 > SQL Editor에 `supabase/migrations/` 안의 파일을 날짜 순서대로(`20261005000000_init.sql` → `20261007000000_alarms.sql` → `20261008000000_docs_media.sql`) 붙여넣고 실행
3. 서버 배포: `supabase functions deploy api` (설정은 `supabase/config.toml`)
4. 비밀 값 등록 (대시보드 > Edge Functions > Secrets): `ANTHROPIC_API_KEY`, `APP_PIN`, `CRON_SECRET`
5. 자동 실행 등록: `supabase/cron.sql`의 두 자리(`<PROJECT_REF>`, `<CRON_SECRET>`)를 채워 SQL Editor에서 실행
6. 앱 설정(톱니바퀴)에 서버 주소 `https://<PROJECT_REF>.supabase.co/functions/v1/api`와 접속 암호 입력

API 키·접속 암호는 Supabase의 비밀 값에만 저장하며, 이 저장소에는 올리지 않습니다.

## 일정 알림 기능 추가 (이미 설치해 쓰고 있다면)

1. SQL Editor에서 `supabase/migrations/20261007000000_alarms.sql` 실행 (기존에 등록해 둔 앞으로의 일정에도 10분 전 알림이 켜짐)
2. 서버 다시 배포: `supabase functions deploy api`
3. SQL Editor에서 `supabase/cron.sql`을 다시 실행 (15분 → 1분 간격, 두 자리 값은 처음처럼 채워서)
4. 앱 설정(톱니바퀴) > 일정 알림 > "휴대폰 알림 받기" → 알림 허용 → "시험 알림 보내기"로 확인

휴대폰 알림 서명 키(VAPID)는 서버가 처음 한 번 만들어 `app_keys` 표에 보관하므로 따로 등록할 필요가 없습니다.

## 도면·제품사진 기능 추가 (이미 설치해 쓰고 있다면)

1. SQL Editor에서 `supabase/migrations/20261008000000_docs_media.sql` 실행 (문서 품번·메모 칸)
2. 서버 다시 배포: `supabase functions deploy api`
3. 이미 올려 둔 도면은 문서 카드에서 삭제 후 다시 올리면 새 방식(도면 판독)으로 읽습니다. 파일 이름에 "도면"을 넣거나 품번·메모에 "도면"을 적어 두면 확실하게 도면으로 읽습니다.
