"""이카운트 Open API 중계 서버 (고정 IP 프록시)

Google Apps Script(부산점 데일리 재고 마감 시트)는 발신 IP가 유동이라
이카운트 API의 IP 화이트리스트를 통과할 수 없다. Render에 배포된 이 서버는
고정 아웃바운드 IP를 가지므로, 시트가 이 서버를 경유해 이카운트 재고현황을 조회한다.

필요 환경변수 (Render Environment):
  ECOUNT_COM_CODE    이카운트 회사코드
  ECOUNT_USER_ID     이카운트 로그인 ID
  ECOUNT_API_KEY     이카운트 API 인증키 (정식)
  ECOUNT_TEST_KEY    이카운트 테스트 인증키 (sboapi 검증용, 선택)
  ECOUNT_RELAY_TOKEN 중계 API 호출 토큰 (Apps Script와 공유하는 임의 문자열)

이카운트 측 사전 작업:
  ERP > API인증키발급 > IP등록 에 Render 아웃바운드 IP(대시보드 Connect > Outbound) 등록
"""
import os
import json
import time
import hmac
import urllib.request
import urllib.error

from flask import Flask, request, jsonify

app = Flask(__name__)

# 세션 캐시 (workers=1 이므로 모듈 전역으로 충분) — live(정식키/oapi), test(테스트키/sboapi) 분리
_sessions = {
    'live': {'zone': None, 'sid': None, 'at': 0},
    'test': {'zone': None, 'sid': None, 'at': 0},
}
SESSION_TTL = 12 * 3600  # 12시간


def _mode(body):
    """요청 body의 test 플래그 → 'test'|'live'"""
    return 'test' if (body or {}).get('test') else 'live'


def _domain(mode):
    return 'sboapi' if mode == 'test' else 'oapi'


def _check_token():
    expected = os.environ.get('ECOUNT_RELAY_TOKEN', '')
    given = request.headers.get('X-Relay-Token', '')
    return bool(expected) and hmac.compare_digest(given, expected)


def _post(url, payload, timeout=30):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'이카운트 HTTP {e.code}: {e.read().decode("utf-8", "replace")[:300]}')
    data = json.loads(body)
    # 이카운트는 HTTP 200이어도 Status/Errors 로 오류를 반환한다 (예: 잘못된 경로 = Status 500 Not Found)
    status = str(data.get('Status', '200'))
    if status != '200':
        errs = data.get('Errors') or []
        msg = '; '.join(f"{e.get('Code', '')}:{e.get('Message', '')}" for e in errs) or json.dumps(data, ensure_ascii=False)[:200]
        raise RuntimeError(f'이카운트 오류 Status {status} — {msg}')
    inner = data.get('Data') or {}
    # 로그인류 응답은 Data.Code 로 오류를 반환한다 (예: 205 = IP 미등록)
    if inner.get('Code') and str(inner.get('Code')) not in ('00', '200'):
        raise RuntimeError(f"이카운트 오류 {inner.get('Code')}: {inner.get('Message', '')}")
    return data


def _login(mode='live'):
    com = os.environ.get('ECOUNT_COM_CODE')
    uid = os.environ.get('ECOUNT_USER_ID')
    key = os.environ.get('ECOUNT_TEST_KEY') if mode == 'test' else os.environ.get('ECOUNT_API_KEY')
    if not (com and uid and key):
        need = 'ECOUNT_TEST_KEY' if mode == 'test' else 'ECOUNT_API_KEY'
        raise RuntimeError(f'서버에 ECOUNT_COM_CODE/USER_ID/{need} 환경변수가 설정되지 않았습니다.')

    dom = _domain(mode)
    zone_res = _post(f'https://{dom}.ecount.com/OAPI/V2/Zone', {'COM_CODE': com})
    zone = (zone_res.get('Data') or {}).get('ZONE')
    if not zone:
        raise RuntimeError(f'ZONE 조회 실패: {json.dumps(zone_res, ensure_ascii=False)[:300]}')

    login_res = _post(f'https://{dom}{zone}.ecount.com/OAPI/V2/OAPILogin', {
        'COM_CODE': com, 'USER_ID': uid, 'API_CERT_KEY': key,
        'LAN_TYPE': 'ko-KR', 'ZONE': zone,
    })
    sid = (((login_res.get('Data') or {}).get('Datas')) or {}).get('SESSION_ID')
    if not sid:
        raise RuntimeError(f'로그인 실패({mode}): {json.dumps(login_res, ensure_ascii=False)[:300]}')

    _sessions[mode].update(zone=zone, sid=sid, at=time.time())
    return _sessions[mode]


def _get_session(force_new=False, mode='live'):
    s = _sessions[mode]
    if not force_new and s['sid'] and time.time() - s['at'] < SESSION_TTL:
        return s
    return _login(mode)


def _api_url(s, mode, path):
    return f"https://{_domain(mode)}{s['zone']}.ecount.com/OAPI/V2/{path}?SESSION_ID={s['sid']}"


def _fetch_inventory(base_date, mode='live'):
    def attempt(force_new):
        s = _get_session(force_new, mode)
        url = _api_url(s, mode, 'InventoryBalance/GetListInventoryBalanceStatusByLocation')
        res = _post(url, {'BASE_DATE': base_date}, timeout=60)
        inner = res.get('Data') or {}
        rows = inner.get('Result') or inner.get('Results') or (inner.get('Datas') or {}).get('Result')
        if rows is None:
            raise RuntimeError(f'예상과 다른 응답 형식: {json.dumps(res, ensure_ascii=False)[:500]}')
        return rows

    try:
        return attempt(False)
    except RuntimeError as e:
        # 세션 만료로 추정되면 재로그인 후 1회 재시도
        if any(k in str(e) for k in ('세션', 'SESSION', '로그인', '만료')):
            return attempt(True)
        raise


@app.route('/api/ecount/ping', methods=['GET'])
def ping():
    """토큰/배포 확인 + 무료 플랜 슬립 해제(wake)용. 이카운트 호출 없음."""
    if not _check_token():
        return jsonify({'ok': False, 'msg': '토큰이 유효하지 않습니다.'}), 401
    return jsonify({'ok': True})


# 전표 저장 API 경로 (이카운트 문서/설정에 따라 다를 수 있어 env로 교체 가능)
SAVE_PATHS = {
    'sale': os.environ.get('ECOUNT_SALE_PATH', 'Sale/SaveSale'),
    # 창고이동입력 공식 경로 (이카운트 OAPI 문서 '기타이동API > 창고이동입력')
    'transfer': os.environ.get('ECOUNT_TRANSFER_PATH', 'Others/SaveLocationTran'),
    # 구매관리 (이카운트 OAPI 문서 '구매관리API')
    'purchase_order': os.environ.get('ECOUNT_PO_PATH', 'Purchases/SavePurchaseOrder'),
    'purchase': os.environ.get('ECOUNT_PURCHASE_PATH', 'Purchases/SavePurchases'),
}


@app.route('/api/ecount/save', methods=['POST'])
def save_slip():
    """전표 저장 중계. body: {"kind": "sale"|"transfer", "list_key": "SaleList",
    "rows": [{필드:값}...]}  — rows 각각이 BulkDatas가 된다. 응답은 이카운트 원본 그대로."""
    if not _check_token():
        return jsonify({'ok': False, 'msg': '토큰이 유효하지 않습니다.'}), 401

    body = request.get_json(silent=True) or {}
    kind = str(body.get('kind', '')).strip()
    list_key = str(body.get('list_key', '')).strip()
    rows = body.get('rows')
    mode = _mode(body)
    if kind not in SAVE_PATHS:
        return jsonify({'ok': False, 'msg': f'kind는 {list(SAVE_PATHS)} 중 하나여야 합니다.'}), 400
    if not list_key or not isinstance(rows, list) or not rows:
        return jsonify({'ok': False, 'msg': 'list_key와 rows(1건 이상)가 필요합니다.'}), 400

    def attempt(force_new):
        s = _get_session(force_new, mode)
        url = _api_url(s, mode, SAVE_PATHS[kind])
        payload = {list_key: [{'BulkDatas': r} for r in rows]}
        return _post(url, payload, timeout=60)

    try:
        try:
            res = attempt(False)
        except RuntimeError as e:
            if any(k in str(e) for k in ('세션', 'SESSION', '로그인', '만료')):
                res = attempt(True)
            else:
                raise
        return jsonify({'ok': True, 'kind': kind, 'mode': mode, 'sent': len(rows), 'result': res})
    except Exception as e:
        return jsonify({'ok': False, 'msg': str(e)}), 502


@app.route('/api/ecount/inventory', methods=['POST'])
def inventory():
    """창고별 재고현황 조회. body: {"base_date": "YYYYMMDD"}"""
    if not _check_token():
        return jsonify({'ok': False, 'msg': '토큰이 유효하지 않습니다.'}), 401

    body = request.get_json(silent=True) or {}
    base_date = str(body.get('base_date', '')).strip()
    if not (len(base_date) == 8 and base_date.isdigit()):
        return jsonify({'ok': False, 'msg': 'base_date는 YYYYMMDD 형식이어야 합니다.'}), 400

    try:
        rows = _fetch_inventory(base_date, _mode(body))
        return jsonify({'ok': True, 'base_date': base_date, 'count': len(rows), 'rows': rows})
    except Exception as e:
        return jsonify({'ok': False, 'msg': str(e)}), 502


# 조회 API 화이트리스트 (읽기 전용) — 이카운트 OAPI 문서 '기초등록API'
QUERY_PATHS = {
    # 품목조회(목록): 이카운트 문서 ViewBasicProductsListApi. 경로/필드는 첫 호출 결과로 확정
    'products': os.environ.get('ECOUNT_PRODUCTS_PATH', 'InventoryBasic/GetBasicProductsList'),
    # 발주서조회 (구매관리API) — 미입고 잔량 동기화용
    'purchase_orders': os.environ.get('ECOUNT_PO_LIST_PATH', 'Purchases/GetPurchasesOrderList'),
}


@app.route('/api/ecount/query', methods=['POST'])
def query():
    """읽기 전용 조회 중계. body: {"kind": "products", "payload": {...}} — 이카운트 응답 Data 그대로 반환.
    kind 미지정 시 body.path 로 직접 경로 지정 가능(디버그용, 'Get'/'View'로 시작하는 읽기 API만 허용)."""
    if not _check_token():
        return jsonify({'ok': False, 'msg': '토큰이 유효하지 않습니다.'}), 401
    body = request.get_json(silent=True) or {}
    kind = str(body.get('kind', '')).strip()
    path = QUERY_PATHS.get(kind) or str(body.get('path', '')).strip()
    if not path:
        return jsonify({'ok': False, 'msg': f'kind는 {list(QUERY_PATHS)} 중 하나이거나 path를 지정하세요.'}), 400
    last = path.split('/')[-1]
    if not (last.startswith('Get') or last.startswith('View')):
        return jsonify({'ok': False, 'msg': '읽기 전용 경로(Get*/View*)만 허용됩니다.'}), 400
    payload = body.get('payload') or {}
    mode = _mode(body)

    def attempt(force_new):
        s = _get_session(force_new, mode)
        url = _api_url(s, mode, path)
        return _post(url, payload, timeout=90)

    try:
        try:
            res = attempt(False)
        except RuntimeError as e:
            if any(k in str(e) for k in ('세션', 'SESSION', '로그인', '만료')):
                res = attempt(True)
            else:
                raise
        return jsonify({'ok': True, 'path': path, 'data': res.get('Data')})
    except Exception as e:
        return jsonify({'ok': False, 'msg': str(e)}), 502


if __name__ == '__main__':
    app.run(port=8100)
