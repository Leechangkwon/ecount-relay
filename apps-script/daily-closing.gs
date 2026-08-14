/**
 * ⚡ 데일리 재고 마감 자동화 (부산점)
 *
 * 메뉴 구성
 *  ① 오늘 탭 생성      : 이카운트 API로 전일 마감재고 수신 → 'M/D 마감 재고' 탭 생성
 *                         → 최신 날짜 탭 복사 → 오늘 이름으로 생성 → 전일재고 수식 갱신
 *                         → 일일 입력칸(P,Q,R,S,V) 초기화 → 오래된 탭 숨김
 *  ② 마감재고만 다시 받기 : 날짜를 지정해 해당일 마감재고 탭만 API로 재생성
 *  ③ API 연결 테스트    : 중계 서버 경유 재고조회 후 응답 요약 + '_API디버그' 시트에 원본 저장
 *  ⚙ API 설정           : 중계 서버 주소/토큰을 스크립트 속성에 저장 (시트에 노출 안 됨)
 *
 * 연동 구조 (이카운트 IP 화이트리스트 때문에 직접 호출 불가 → 고정 IP 서버 경유)
 *  Apps Script → ecount-relay 서버(Render 무료, 고정 아웃바운드 IP) → 이카운트 OAPI
 *  Render 아웃바운드 IP를 이카운트 ERP > API인증키발급 > IP등록에 등록해야 함.
 *  이카운트 회사코드/ID/인증키는 서버 환경변수에만 저장됨. 여기서는 서버 주소+토큰만 설정.
 *  무료 플랜은 유휴 시 잠들기 때문에 호출 전 ping으로 깨우는 로직 포함.
 */

// ══════════════════════════ 설정 ══════════════════════════

var CONFIG = {
  // 새 날짜 탭 생성 시 비우는 일일 입력칸 (불출1차, 불출2차, 환입, 구매입고, 페일)
  CLEAR_COLS: ['P', 'Q', 'R', 'S', 'V'],
  // 데이터 시작 행 (1행: 구역 제목, 2행: 헤더)
  DATA_START_ROW: 3,
  // 전일재고 수식: G열(중앙공급실) ← 마감재고 G열, M열(창고) ← 마감재고 J열
  PREV_STOCK: [
    { dailyCol: 'G', closingCol: 'G' },
    { dailyCol: 'M', closingCol: 'J' }
  ],
  // 마감재고 탭 창고 컬럼 순서 (F~J열). 이카운트 창고명과 정확히 일치해야 함
  WAREHOUSES: [
    '플란치과_부산점_13층 수술방',
    '플란치과_부산점_13층 중앙공급실(구매팀)',
    '플란치과_부산점_13층 중앙공급실(보철)',
    '플란치과_부산점_13층 중앙공급실(수술)',
    '플란치과_부산점_구매팀 창고'
  ],
  // 창고명 자동 매칭 실패 시 창고코드로 매칭 (② API 연결 테스트로 코드 확인 후 기입)
  WAREHOUSE_CODES: ['', '', '', '', ''],
  COMPANY_TITLE: '회사명 : 주식회사 플란랩',
  ITEM_SHEET: '품목 정보',
  // 새 탭 생성 후 화면에 남겨둘 최근 일수(날짜 탭/마감재고 탭 각각). 나머지는 숨김
  KEEP_VISIBLE_DAYS: 3,
  DEBUG_SHEET: '_API디버그'
};

// ══════════════════════════ 메뉴 ══════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ 재고마감')
    .addItem('① 오늘 탭 생성', 'createTodayTab')
    .addItem('② 마감재고만 다시 받기', 'refetchClosingStock')
    .addSeparator()
    .addItem('③ API 연결 테스트', 'testApi')
    .addItem('⚙ API 설정', 'setupApiKeys')
    .addToUi();
}

// ══════════════════════════ ① 오늘 탭 생성 ══════════════════════════

function createTodayTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var today = new Date();
  var todayName = tabNameForDate(today);

  if (ss.getSheetByName(todayName)) {
    ui.alert('이미 "' + todayName + '" 탭이 있습니다. 삭제 후 다시 실행하세요.');
    return;
  }

  // 1) 최신 날짜 탭 찾기 (오늘보다 과거인 것 중 가장 최근)
  var latest = findLatestDailyTab(ss, today);
  if (!latest) {
    ui.alert('복사할 이전 날짜 탭을 찾지 못했습니다.');
    return;
  }
  var prevSheet = latest.sheet;
  var prevDate = latest.date;
  var closingName = prevSheet.getName() + ' 마감 재고';

  // 2) 이카운트 API로 전일 마감재고 수신 → 마감재고 탭 생성/갱신
  var apiOk = false;
  try {
    buildClosingSheet(ss, prevDate, closingName);
    apiOk = true;
  } catch (e) {
    var existing = ss.getSheetByName(closingName);
    var msg = '이카운트 API 호출 실패:\n' + e.message + '\n\n';
    if (existing) {
      var go = ui.alert(msg + '기존 "' + closingName + '" 탭을 그대로 사용해 오늘 탭을 만들까요?', ui.ButtonSet.YES_NO);
      if (go !== ui.Button.YES) return;
    } else {
      ui.alert(msg + '"' + closingName + '" 탭이 없어 중단합니다.\n③ API 연결 테스트로 원인을 확인하세요.');
      return;
    }
  }

  // 3) 최신 날짜 탭 복사 → 오늘 이름으로
  var newSheet = prevSheet.copyTo(ss).setName(todayName);
  ss.setActiveSheet(newSheet);
  ss.moveActiveSheet(prevSheet.getIndex() + 1); // 이전 날짜 탭 바로 뒤에 배치
  newSheet.showSheet();

  var lastRow = newSheet.getLastRow();
  var startRow = CONFIG.DATA_START_ROW;
  var n = lastRow - startRow + 1;
  if (n > 0) {
    var itemCodes = newSheet.getRange(startRow, 4, n, 1).getValues(); // D열 품목코드

    // 4) 전일재고 수식 갱신 (G, M열 → 방금 만든 마감재고 탭 참조)
    CONFIG.PREV_STOCK.forEach(function (m) {
      var formulas = itemCodes.map(function (row, i) {
        if (!row[0]) return [''];
        var r = startRow + i;
        return ["=iferror(XLOOKUP($D" + r + ",'" + closingName + "'!$A:$A,'" + closingName + "'!$" + m.closingCol + ":$" + m.closingCol + "),0)"];
      });
      newSheet.getRange(m.dailyCol + startRow + ':' + m.dailyCol + lastRow).setFormulas(formulas);
    });

    // 5) 일일 입력칸 초기화
    CONFIG.CLEAR_COLS.forEach(function (col) {
      newSheet.getRange(col + startRow + ':' + col + lastRow).clearContent();
    });
  }

  // 6) 오래된 탭 숨김
  hideOldTabs(ss, today);

  ui.alert('"' + todayName + '" 탭 생성 완료.\n' +
    '· 전일재고 참조: ' + closingName + (apiOk ? ' (API 자동 수신)' : ' (기존 탭 사용)') + '\n' +
    '· 초기화: ' + CONFIG.CLEAR_COLS.join(', ') + '열');
}

// ══════════════════════════ ② 마감재고만 다시 받기 ══════════════════════════

function refetchClosingStock() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('마감재고를 받을 날짜를 입력하세요 (예: 8/13 또는 20260813)', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var raw = res.getResponseText().trim();

  var date;
  if (/^\d{8}$/.test(raw)) {
    date = new Date(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8)));
  } else {
    date = dateForTabName(raw, new Date());
  }
  if (!date) { ui.alert('날짜를 해석할 수 없습니다: ' + raw); return; }

  var closingName = tabNameForDate(date) + ' 마감 재고';
  try {
    var count = buildClosingSheet(ss, date, closingName);
    ui.alert('"' + closingName + '" 갱신 완료 (품목 ' + count + '건).');
  } catch (e) {
    ui.alert('실패: ' + e.message + '\n③ API 연결 테스트로 원인을 확인하세요.');
  }
}

/**
 * 이카운트 API에서 baseDate 기준 창고별 재고를 받아 closingName 탭을 만든다.
 * 기존 탭이 있으면 내용을 교체. 품목명/규격/단위/단가/분류는 '품목 정보' 탭에서 보강.
 */
function buildClosingSheet(ss, baseDate, closingName) {
  var rows = ecountFetchInventory(Utilities.formatDate(baseDate, 'Asia/Seoul', 'yyyyMMdd'));

  // 창고 → 컬럼 인덱스 매핑 (이름 우선, 실패 시 코드)
  var whColByName = {}, whColByCode = {};
  CONFIG.WAREHOUSES.forEach(function (name, i) { whColByName[normalize_(name)] = i; });
  CONFIG.WAREHOUSE_CODES.forEach(function (cd, i) { if (cd) whColByCode[String(cd)] = i; });

  // 품목 정보 인덱스: 품목코드 → {품목명, 규격, 단위, 입고단가, 대분류, 중분류}
  var itemInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[3] !== '' && r[3] != null) {
        itemInfo[String(r[3])] = { name: r[4], size: r[5], unit: r[6], price: r[7], cat1: r[1], cat2: r[2] };
      }
    });
  }

  // 응답에는 전 지점 창고가 포함됨 — CONFIG.WAREHOUSES 5개(부산점)만 사용하고 나머지는 무시
  var items = {}; // 품목코드 → {qty:[5], des}
  rows.forEach(function (r) {
    var prodCd = String(firstOf_(r, ['PROD_CD', 'ProdCd', 'PRODUCT_CD']) || '').trim();
    var qty = Number(firstOf_(r, ['BAL_QTY', 'BalQty', 'QTY', 'STOCK_QTY']) || 0);
    if (!prodCd || !qty) return;
    var whDes = String(firstOf_(r, ['WH_DES', 'WhDes', 'WH_NM', 'WAREHOUSE_DES']) || '').trim();
    var whCd = String(firstOf_(r, ['WH_CD', 'WhCd', 'WAREHOUSE_CD']) || '').trim();
    var col = whColByName.hasOwnProperty(normalize_(whDes)) ? whColByName[normalize_(whDes)]
            : whColByCode.hasOwnProperty(whCd) ? whColByCode[whCd]
            : -1;
    if (col < 0) return;
    if (!items[prodCd]) items[prodCd] = { qty: [null, null, null, null, null], des: firstOf_(r, ['PROD_DES', 'ProdDes']) || '' };
    items[prodCd].qty[col] = (items[prodCd].qty[col] || 0) + qty;
  });

  var codes = Object.keys(items).sort();
  if (!codes.length) throw new Error('API 응답에 재고 데이터가 없습니다. (기준일: ' + Utilities.formatDate(baseDate, 'Asia/Seoul', 'yyyy-MM-dd') + ')');

  var out = [];
  codes.forEach(function (cd) {
    var it = items[cd];
    var info = itemInfo[cd] || {};
    var sum = it.qty.reduce(function (a, b) { return a + (b || 0); }, 0);
    out.push([cd, info.name || it.des, info.size || '', info.unit || '',
      sum, it.qty[0], it.qty[1], it.qty[2], it.qty[3], it.qty[4],
      info.price || '', info.cat1 || '', info.cat2 || '']);
  });

  var sheet = ss.getSheetByName(closingName);
  if (sheet) {
    sheet.clearContents();
  } else {
    sheet = ss.insertSheet(closingName, ss.getSheets().length);
  }
  sheet.getRange(1, 1).setValue(CONFIG.COMPANY_TITLE);
  sheet.getRange(2, 1, 1, 13).setValues([[
    '품목코드', '품목명', '규격', '단위', '합계',
    CONFIG.WAREHOUSES[0], CONFIG.WAREHOUSES[1], CONFIG.WAREHOUSES[2], CONFIG.WAREHOUSES[3], CONFIG.WAREHOUSES[4],
    '입고단가', '대분류', '중분류'
  ]]);
  sheet.getRange(3, 1, out.length, 13).setValues(out);

  return out.length;
}

// ══════════════════════════ 이카운트 API (중계 서버 경유) ══════════════════════════

function setupApiKeys() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  [
    'RELAY_URL|중계 서버 주소 (예: https://ecount-relay.onrender.com)',
    'RELAY_TOKEN|중계 토큰 (서버 ECOUNT_RELAY_TOKEN과 동일 값)'
  ].forEach(function (spec) {
    var key = spec.split('|')[0], label = spec.split('|')[1];
    var cur = props.getProperty(key);
    var res = ui.prompt('⚙ ' + label + (cur ? '\n(현재: 설정됨, 비워두면 유지)' : ''), ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    var v = res.getResponseText().trim();
    if (v) props.setProperty(key, v.replace(/\/+$/, ''));
  });
  ui.alert('저장 완료. "③ API 연결 테스트"로 확인하세요.');
}

function getRelayProps_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('RELAY_URL'), token = p.getProperty('RELAY_TOKEN');
  if (!url || !token) throw new Error('중계 서버가 설정되지 않았습니다. "⚙ API 설정"을 먼저 실행하세요.');
  return { url: url, token: token };
}

/** Render 무료 플랜 슬립 해제: ping이 응답할 때까지 최대 2분 대기 */
function wakeRelay_(relay) {
  for (var i = 0; i < 8; i++) {
    try {
      var res = UrlFetchApp.fetch(relay.url + '/api/ecount/ping', {
        headers: { 'X-Relay-Token': relay.token },
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) return;
      if (code === 401) throw new Error('중계 토큰이 서버와 일치하지 않습니다. "⚙ API 설정"을 확인하세요.');
    } catch (e) {
      if (String(e.message).indexOf('중계 토큰') === 0) throw e;
      // 서버 기동 중 — 잠시 후 재시도
    }
    Utilities.sleep(15000);
  }
  throw new Error('중계 서버가 응답하지 않습니다 (2분 대기 초과). Render 서비스 상태를 확인하세요.');
}

/** 창고별 재고현황 조회 (중계 서버 경유). 반환: 행 객체 배열 */
function ecountFetchInventory(baseDateYmd) {
  var relay = getRelayProps_();
  wakeRelay_(relay);
  var url = relay.url + '/api/ecount/inventory';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Relay-Token': relay.token },
    payload: JSON.stringify({ base_date: baseDateYmd }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  logDebug_(url, { base_date: baseDateYmd }, code, text);
  var json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('HTTP ' + code + ' — 응답 해석 실패: ' + text.slice(0, 300)); }
  if (code !== 200 || !json.ok) throw new Error((json && json.msg) || ('HTTP ' + code + ' — ' + text.slice(0, 300)));
  if (!json.rows) throw new Error('예상과 다른 응답 형식입니다. "_API디버그" 시트를 확인하세요.');
  return json.rows;
}

function testApi() {
  var ui = SpreadsheetApp.getUi();
  try {
    var ymd = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
    var rows = ecountFetchInventory(ymd);
    var whSet = {};
    rows.forEach(function (r) {
      var des = firstOf_(r, ['WH_DES', 'WhDes', 'WH_NM', 'WAREHOUSE_DES']) || '';
      var cd = firstOf_(r, ['WH_CD', 'WhCd', 'WAREHOUSE_CD']) || '';
      whSet[cd + ' : ' + des] = true;
    });
    ui.alert('✅ 연결 성공\n오늘 기준 재고 행 수: ' + rows.length +
      '\n\n창고 목록:\n' + Object.keys(whSet).join('\n') +
      '\n\n원본 응답은 "' + CONFIG.DEBUG_SHEET + '" 시트에 저장됐습니다.');
  } catch (e) {
    ui.alert('❌ 실패: ' + e.message + '\n\n"' + CONFIG.DEBUG_SHEET + '" 시트에서 원본 응답을 확인하세요.');
  }
}

function logDebug_(url, payload, code, text) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.DEBUG_SHEET) || ss.insertSheet(CONFIG.DEBUG_SHEET);
    var safePayload = JSON.stringify(payload).replace(/"API_CERT_KEY":"[^"]*"/, '"API_CERT_KEY":"***"');
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, 4).setValues([[new Date(), url.replace(/SESSION_ID=[^&]*/, 'SESSION_ID=***'), safePayload, String(code) + ' | ' + text.slice(0, 45000)]]);
    if (sheet.getLastRow() > 30) sheet.deleteRows(31, sheet.getLastRow() - 30); // 최근 30건만 유지
    sheet.hideSheet();
  } catch (e) { /* 디버그 로그 실패는 무시 */ }
}

// ══════════════════════════ 날짜/탭 유틸 ══════════════════════════
// 탭 이름 형식: 날짜 탭 'M/D' (예: 8/13), 마감 탭 'M/D 마감 재고'

/** Date → 탭 이름 (예: 2026-08-14 → '8/14') */
function tabNameForDate(d) {
  return String(d.getMonth() + 1) + '/' + String(d.getDate());
}

/** 탭 이름 'M/D' → Date (올해 기준, 미래·비실존 날짜는 null) */
function dateForTabName(name, refDate) {
  var m = String(name).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  var month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  var date = new Date(refDate.getFullYear(), month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null; // 실존 날짜만
  if (date.getTime() > refDate.getTime()) return null; // 미래 제외
  return date;
}

/** 오늘보다 과거인 날짜 탭 중 가장 최근 것 */
function findLatestDailyTab(ss, today) {
  var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var best = null;
  ss.getSheets().forEach(function (sheet) {
    var d = dateForTabName(sheet.getName(), new Date(todayStart.getTime() - 1)); // 오늘 제외
    if (d && (!best || d.getTime() > best.date.getTime())) best = { sheet: sheet, date: d };
  });
  return best;
}

/** 최근 KEEP_VISIBLE_DAYS일 이전의 날짜/마감재고 탭 숨김 */
function hideOldTabs(ss, today) {
  var cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - CONFIG.KEEP_VISIBLE_DAYS);
  ss.getSheets().forEach(function (sheet) {
    var m = sheet.getName().match(/^(\d{1,2}\/\d{1,2})( 마감 재고)?$/);
    if (!m) return;
    var d = dateForTabName(m[1], today);
    if (d && d.getTime() < cutoff.getTime()) sheet.hideSheet();
  });
}

// ══════════════════════════ 공통 유틸 ══════════════════════════

function firstOf_(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] != null && obj[keys[i]] !== '') return obj[keys[i]];
  }
  return null;
}

function normalize_(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}
