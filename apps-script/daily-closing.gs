/**
 * ⚡ 데일리 재고 마감 자동화 (부산점)
 *
 * 메뉴 구성
 *  ① 오늘 탭 생성      : 이카운트 API로 전일 마감재고 수신 → 'M/D 마감 재고' 탭 생성
 *                         → 최신 날짜 탭 복사 → 오늘 이름으로 생성 → 전일재고 수식 갱신
 *                         → 일일 입력칸(P,Q,R,S,V) 초기화 → 오래된 탭 숨김
 *  ② 마감재고만 다시 받기 : 날짜를 지정해 해당일 마감재고 탭만 API로 재생성
 *  ③ 마감 전표 미리보기  : 오늘 탭 입력값으로 판매/이동/환입 전표 초안 생성 (수정 가능)
 *  ④ 전표 전송           : 미리보기 검토 후 이카운트로 전송 (전송 이력 기록, 중복 방지)
 *  ⑤ 재고 재점검         : 전송 후 실재고를 다시 받아 시트 계산재고와 대조 리포트
 *  ⑥ API 연결 테스트    : 중계 서버 경유 재고조회 후 응답 요약 + '_API디버그' 시트에 원본 저장
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
  // 전일재고 수식: 날짜 탭 열 ← 마감재고 탭에서 "해당 창고명 헤더가 있는 열"
  // (열 위치 고정이 아니라 마감재고 2행 헤더에서 창고명을 찾아 매칭 — 열 순서가 바뀌어도 안전)
  PREV_STOCK: [
    { dailyCol: 'G', warehouse: '플란치과_부산점_13층 중앙공급실(구매팀)' },
    { dailyCol: 'M', warehouse: '플란치과_부산점_구매팀 창고' }
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
  DEBUG_SHEET: '_API디버그',

  // ── 전표 전송 (판매/이동) ──
  // 창고명 → 이카운트 창고코드 (⑥ API 연결 테스트의 창고 목록에서 확인)
  WH_CODES: {
    '플란치과_부산점_13층 수술방': '00041',
    '플란치과_부산점_13층 중앙공급실(구매팀)': '00032',
    '플란치과_부산점_13층 중앙공급실(보철)': '00060',
    '플란치과_부산점_13층 중앙공급실(수술)': '00068',
    '플란치과_부산점_구매팀 창고': '00039'
  },
  // 재고 흐름: 구매팀창고 →(이동:불출 P+Q)→ 중앙공급실 →(이동:보충 K)→ 수술방 →(판매 K)→ 사용
  WH_SURGERY: '플란치과_부산점_13층 수술방',
  WH_CENTRAL: '플란치과_부산점_13층 중앙공급실(구매팀)',
  WH_STORAGE: '플란치과_부산점_구매팀 창고',
  SALE_CUST: '부산점',          // 판매전표 거래처코드 (이카운트 거래처코드와 다르면 수정)
  // 이카운트 저장 API 필드명 (설정에 따라 다르면 여기만 수정)
  SALE_LIST_KEY: 'SaleList',
  TRANSFER_LIST_KEY: 'InventoryMovementList',
  TRANSFER_FROM_FIELD: 'FROM_WH_CD',
  TRANSFER_TO_FIELD: 'TO_WH_CD',
  PREVIEW_SHEET: '_전표전송',
  CHECK_SHEET: '_재고점검'
};

// ══════════════════════════ 메뉴 ══════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ 재고마감')
    .addItem('① 오늘 탭 생성', 'createTodayTab')
    .addItem('② 마감재고만 다시 받기', 'refetchClosingStock')
    .addSeparator()
    .addItem('③ 마감 전표 미리보기', 'makeSlipPreview')
    .addItem('④ 전표 전송 (미리보기 승인)', 'sendSlips')
    .addItem('⑤ 재고 재점검', 'checkInventory')
    .addSeparator()
    .addItem('⑥ API 연결 테스트', 'testApi')
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
      ui.alert(msg + '"' + closingName + '" 탭이 없어 중단합니다.\n⑥ API 연결 테스트로 원인을 확인하세요.');
      return;
    }
  }

  // 3) 마감재고 탭 헤더(2행)에서 창고명 → 열 위치 해석 (열 순서가 바뀌어도 안전)
  var closingCols;
  try {
    closingCols = resolveClosingCols_(ss, closingName);
  } catch (e) {
    ui.alert(e.message);
    return;
  }

  // 4) 최신 날짜 탭 복사 → 오늘 이름으로
  var newSheet = prevSheet.copyTo(ss).setName(todayName);
  ss.setActiveSheet(newSheet);
  ss.moveActiveSheet(prevSheet.getIndex() + 1); // 이전 날짜 탭 바로 뒤에 배치
  newSheet.showSheet();

  var lastRow = newSheet.getLastRow();
  var startRow = CONFIG.DATA_START_ROW;
  var n = lastRow - startRow + 1;
  if (n > 0) {
    var itemCodes = newSheet.getRange(startRow, 4, n, 1).getValues(); // D열 품목코드

    // 5) 전일재고 수식 갱신 (창고명으로 해석한 마감재고 열 참조)
    CONFIG.PREV_STOCK.forEach(function (m) {
      var col = closingCols[m.warehouse];
      var formulas = itemCodes.map(function (row, i) {
        if (!row[0]) return [''];
        var r = startRow + i;
        return ["=iferror(XLOOKUP($D" + r + ",'" + closingName + "'!$A:$A,'" + closingName + "'!$" + col + ":$" + col + "),0)"];
      });
      newSheet.getRange(m.dailyCol + startRow + ':' + m.dailyCol + lastRow).setFormulas(formulas);
    });

    // 6) 일일 입력칸 초기화
    CONFIG.CLEAR_COLS.forEach(function (col) {
      newSheet.getRange(col + startRow + ':' + col + lastRow).clearContent();
    });
  }

  // 7) 오래된 탭 숨김
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
    ui.alert('실패: ' + e.message + '\n⑥ API 연결 테스트로 원인을 확인하세요.');
  }
}

/**
 * 마감재고 탭 2행 헤더에서 PREV_STOCK의 창고명이 몇 열에 있는지 찾아
 * {창고명: 열문자} 맵을 반환. 없으면 오류 (공백 차이는 무시하고 비교).
 */
function resolveClosingCols_(ss, closingName) {
  var sheet = ss.getSheetByName(closingName);
  if (!sheet) throw new Error('"' + closingName + '" 탭을 찾을 수 없습니다.');
  var headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  CONFIG.PREV_STOCK.forEach(function (m) {
    var idx = -1;
    for (var i = 0; i < headers.length; i++) {
      if (normalize_(headers[i]) === normalize_(m.warehouse)) { idx = i; break; }
    }
    if (idx < 0) {
      throw new Error('"' + closingName + '" 탭 헤더(2행)에서 창고 "' + m.warehouse + '"를 찾지 못했습니다.\n' +
        '마감재고 탭의 창고명과 CONFIG.PREV_STOCK 설정을 확인하세요.');
    }
    map[m.warehouse] = columnLetter_(idx + 1);
  });
  return map;
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

// ══════════════════════════ ③④⑤ 전표 전송 & 재고 재점검 ══════════════════════════

/**
 * ③ 오늘 탭의 입력값으로 전송할 전표 초안을 '_전표전송' 탭에 생성.
 * 판매(수술방, K열) / 이동 중앙→수술방(K열) / 이동 창고→중앙(P+Q열) / 환입 중앙→창고(R열)
 * 수량은 미리보기 탭에서 수정 가능. 행을 지우거나 수량을 0으로 만들면 전송 제외.
 */
function makeSlipPreview() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var today = new Date();
  var todaySheet = ss.getSheetByName(tabNameForDate(today));
  if (!todaySheet) { ui.alert('오늘 날짜 탭("' + tabNameForDate(today) + '")이 없습니다. ① 오늘 탭 생성을 먼저 실행하세요.'); return; }

  var ymd = Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd');
  var startRow = CONFIG.DATA_START_ROW;
  var lastRow = todaySheet.getLastRow();
  // D품목코드(4), E품목명(5), K판매(11), P불출1(16), Q불출2(17), R환입(18)
  var data = todaySheet.getRange(startRow, 1, lastRow - startRow + 1, 18).getValues();

  var itemInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[3] !== '' && r[3] != null) itemInfo[String(r[3])] = { price: Number(r[7]) || 0 };
    });
  }

  var rows = [];
  data.forEach(function (r) {
    var code = r[3], name = r[4];
    if (!code) return;
    var sale = Number(r[10]) || 0;   // K 판매(수식)
    var out1 = Number(r[15]) || 0;   // P 불출1차
    var out2 = Number(r[16]) || 0;   // Q 불출2차
    var ret = Number(r[17]) || 0;    // R 환입
    if (sale > 0) {
      rows.push(['판매', ymd, CONFIG.WH_SURGERY, '', code, name, sale, (itemInfo[code] || {}).price || 0, '대기', '']);
      rows.push(['이동', ymd, CONFIG.WH_CENTRAL, CONFIG.WH_SURGERY, code, name, sale, '', '대기', '']);
    }
    if (out1 + out2 > 0) rows.push(['이동', ymd, CONFIG.WH_STORAGE, CONFIG.WH_CENTRAL, code, name, out1 + out2, '', '대기', '']);
    if (ret > 0) rows.push(['환입', ymd, CONFIG.WH_CENTRAL, CONFIG.WH_STORAGE, code, name, ret, '', '대기', '']);
  });

  var sheet = ss.getSheetByName(CONFIG.PREVIEW_SHEET) || ss.insertSheet(CONFIG.PREVIEW_SHEET, ss.getSheets().length);
  sheet.clearContents();
  sheet.getRange(1, 1).setValue('전송 전 검토용 — 수량 수정 가능. 빼려면 행 삭제 또는 수량 0. 검토 후 "④ 전표 전송" 실행');
  sheet.getRange(2, 1, 1, 10).setValues([['유형', '일자', '보내는창고', '받는창고(판매는 공란)', '품목코드', '품목명', '수량', '단가(판매만)', '상태', '전표결과']]);
  if (rows.length) sheet.getRange(3, 1, rows.length, 10).setValues(rows);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  var cnt = { '판매': 0, '이동': 0, '환입': 0 };
  rows.forEach(function (r) { cnt[r[0]]++; });
  ui.alert('전표 초안 생성 완료 — 판매 ' + cnt['판매'] + '건, 이동 ' + cnt['이동'] + '건, 환입 ' + cnt['환입'] + '건.\n' +
    '"' + CONFIG.PREVIEW_SHEET + '" 탭에서 검토·수정 후 "④ 전표 전송"을 실행하세요.');
}

/** ④ 미리보기 탭의 '대기' 행을 이카운트로 전송 (판매 1묶음 + 이동/환입 방향별 묶음) */
function sendSlips() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(CONFIG.PREVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 3) { ui.alert('전송할 미리보기가 없습니다. "③ 마감 전표 미리보기"를 먼저 실행하세요.'); return; }

  var range = sheet.getRange(3, 1, sheet.getLastRow() - 2, 10);
  var rows = range.getValues();
  var pend = [];
  rows.forEach(function (r, i) {
    if (String(r[8]) === '대기' && Number(r[6]) > 0 && r[4]) pend.push({ i: i, r: r });
  });
  if (!pend.length) { ui.alert('전송 대기 행이 없습니다. (상태가 "대기"이고 수량>0인 행만 전송)'); return; }

  var cnt = { '판매': 0, '이동': 0, '환입': 0 };
  pend.forEach(function (p) { cnt[p.r[0]]++; });
  var go = ui.alert('이카운트로 전송합니다:\n· 판매 ' + cnt['판매'] + '건\n· 이동 ' + cnt['이동'] + '건\n· 환입 ' + cnt['환입'] + '건\n\n진행할까요?', ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  // 판매: 한 전표로 묶음
  var saleRows = pend.filter(function (p) { return p.r[0] === '판매'; });
  var saleBulk = saleRows.map(function (p) {
    return {
      IO_DATE: String(p.r[1]), UPLOAD_SER_NO: '1',
      CUST: CONFIG.SALE_CUST, WH_CD: CONFIG.WH_CODES[p.r[2]] || '',
      PROD_CD: String(p.r[4]), QTY: String(p.r[6]), PRICE: String(p.r[7] || 0)
    };
  });

  // 이동/환입: 보내는창고→받는창고 방향별로 전표 묶음 (UPLOAD_SER_NO 구분)
  var moveRows = pend.filter(function (p) { return p.r[0] !== '판매'; });
  var dirSer = {}, serSeq = 0;
  var moveBulk = moveRows.map(function (p) {
    var dir = p.r[2] + '>' + p.r[3];
    if (!dirSer[dir]) dirSer[dir] = String(++serSeq);
    var row = { IO_DATE: String(p.r[1]), UPLOAD_SER_NO: dirSer[dir], PROD_CD: String(p.r[4]), QTY: String(p.r[6]) };
    row[CONFIG.TRANSFER_FROM_FIELD] = CONFIG.WH_CODES[p.r[2]] || '';
    row[CONFIG.TRANSFER_TO_FIELD] = CONFIG.WH_CODES[p.r[3]] || '';
    return row;
  });

  var results = [];
  if (saleBulk.length) results.push({ label: '판매', rows: saleRows, res: relaySave_('sale', CONFIG.SALE_LIST_KEY, saleBulk) });
  if (moveBulk.length) results.push({ label: '이동', rows: moveRows, res: relaySave_('transfer', CONFIG.TRANSFER_LIST_KEY, moveBulk) });

  // 결과를 미리보기 탭 상태열에 반영
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM-dd HH:mm');
  var summary = [];
  results.forEach(function (b) {
    var okMsg = '전송완료 ' + now, failMsg = null;
    if (!b.res.ok) failMsg = '오류: ' + String(b.res.msg).slice(0, 80);
    else {
      var d = (b.res.result && b.res.result.Data) || {};
      var fail = Number(d.FailCnt || 0);
      if (fail > 0) failMsg = '오류: 이카운트 ' + fail + '건 실패 — "' + CONFIG.DEBUG_SHEET + '" 시트 확인';
    }
    b.rows.forEach(function (p) {
      rows[p.i][8] = failMsg || okMsg;
      rows[p.i][9] = failMsg ? '' : JSON.stringify(((b.res.result || {}).Data || {}).SlipNos || '').slice(0, 60);
    });
    summary.push('· ' + b.label + ': ' + (failMsg || (b.rows.length + '건 성공')));
  });
  range.setValues(rows);

  ui.alert('전송 결과\n' + summary.join('\n') + '\n\n이어서 "⑤ 재고 재점검"으로 실재고를 확인하세요.');
}

/** ⑤ API 실재고 vs 오늘 탭 계산재고(L 입고후재고=중앙, T 불출후재고=창고) 대조 */
function checkInventory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var today = new Date();
  var todaySheet = ss.getSheetByName(tabNameForDate(today));
  if (!todaySheet) { ui.alert('오늘 날짜 탭이 없습니다.'); return; }

  var rowsApi = ecountFetchInventory(Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd'));
  var actual = {}; // 품목코드 → {central, storage}
  rowsApi.forEach(function (r) {
    var wh = String(firstOf_(r, ['WH_DES', 'WhDes']) || '').trim();
    var code = String(firstOf_(r, ['PROD_CD', 'ProdCd']) || '').trim();
    var qty = Number(firstOf_(r, ['BAL_QTY', 'BalQty']) || 0);
    if (!code) return;
    if (normalize_(wh) === normalize_(CONFIG.WH_CENTRAL)) (actual[code] = actual[code] || {}).central = (actual[code].central || 0) + qty;
    if (normalize_(wh) === normalize_(CONFIG.WH_STORAGE)) (actual[code] = actual[code] || {}).storage = (actual[code].storage || 0) + qty;
  });

  var startRow = CONFIG.DATA_START_ROW;
  var data = todaySheet.getRange(startRow, 1, todaySheet.getLastRow() - startRow + 1, 20).getValues();
  var diffs = [];
  data.forEach(function (r) {
    var code = r[3], name = r[4];
    if (!code) return;
    var a = actual[String(code)] || {};
    var expCentral = Number(r[11]) || 0;  // L 입고 후 재고
    var expStorage = Number(r[19]) || 0;  // T 불출 후 재고
    var actCentral = a.central || 0, actStorage = a.storage || 0;
    if (Math.abs(expCentral - actCentral) > 0.001) diffs.push([code, name, CONFIG.WH_CENTRAL, expCentral, actCentral, actCentral - expCentral]);
    if (Math.abs(expStorage - actStorage) > 0.001) diffs.push([code, name, CONFIG.WH_STORAGE, expStorage, actStorage, actStorage - expStorage]);
  });

  var sheet = ss.getSheetByName(CONFIG.CHECK_SHEET) || ss.insertSheet(CONFIG.CHECK_SHEET, ss.getSheets().length);
  sheet.clearContents();
  sheet.getRange(1, 1).setValue('재고 재점검 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' — 시트 계산재고 vs 이카운트 실재고 (차이 품목만)');
  sheet.getRange(2, 1, 1, 6).setValues([['품목코드', '품목명', '창고', '시트 계산재고', '이카운트 실재고', '차이(실재고-계산)']]);
  if (diffs.length) sheet.getRange(3, 1, diffs.length, 6).setValues(diffs);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  ui.alert(diffs.length === 0
    ? '✅ 전 품목 일치 — 시트 계산재고와 이카운트 실재고가 같습니다.'
    : '⚠ 불일치 ' + diffs.length + '건 — "' + CONFIG.CHECK_SHEET + '" 탭에서 확인하세요.\n(전표가 방금 전송된 경우 이카운트 반영까지 잠시 걸릴 수 있습니다)');
}

/** 전표 저장 중계 호출. 반환: {ok, msg?, result?} (오류를 던지지 않고 객체로 반환) */
function relaySave_(kind, listKey, bulkRows) {
  try {
    var relay = getRelayProps_();
    wakeRelay_(relay);
    var url = relay.url + '/api/ecount/save';
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Relay-Token': relay.token },
      payload: JSON.stringify({ kind: kind, list_key: listKey, rows: bulkRows }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    logDebug_(url + ' [' + kind + ']', { count: bulkRows.length, sample: bulkRows[0] }, code, text);
    var json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, msg: 'HTTP ' + code + ' 응답 해석 실패' }; }
    if (code !== 200 || !json.ok) return { ok: false, msg: (json && json.msg) || ('HTTP ' + code) };
    return { ok: true, result: json.result };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
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
  ui.alert('저장 완료. "⑥ API 연결 테스트"로 확인하세요.');
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
    if (sheet.isSheetHidden()) return; // 이미 숨겨진 탭은 건너뜀 (속도)
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

/** 열 번호(1-base) → 열 문자 (예: 1→A, 27→AA) */
function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
