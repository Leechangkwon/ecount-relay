# ecount-relay

이카운트 Open API 중계 서버. Google Apps Script(부산점 데일리 재고 마감 시트)가
이카운트의 IP 화이트리스트를 통과할 수 있도록, 고정 아웃바운드 IP를 가진
Render 서버를 경유시킨다.

- `GET /api/ecount/ping` — 토큰 확인 + 무료 플랜 슬립 해제
- `POST /api/ecount/inventory` — body `{"base_date": "YYYYMMDD"}` → 창고별 재고현황

인증: `X-Relay-Token` 헤더 (환경변수 `ECOUNT_RELAY_TOKEN`과 일치해야 함).

배포 후 할 일: Render 대시보드 > 서비스 > Connect > Outbound IP 3개를
이카운트 ERP > API인증키발급 > IP등록 에 등록.
