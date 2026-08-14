/**
 * ⚡ 데일리 재고 마감 자동화 v2 (부산점) — 단일 탭 + 일별기록 구조
 *
 * 탭 구성
 *  [재고]      : 매일 작업하는 단일 탭 (날짜 탭 복제 없음)
 *  [일별기록]  : 마감 시 전 품목 스냅샷이 한 줄씩 쌓이는 감사용 로그
 *  [품목 정보] / [_전표전송] / [_재고점검] / [_API디버그]
 *
 * 매일 루틴
 *  ① 아침 준비   : 이카운트 API로 전일 중앙/창고/수술방 재고 자동 입력 + 입력칸 초기화
 *                   + 사용량(1일)을 일별기록 최근 14일 소비로 재계산
 *  (실사 입력: 중앙공급실 실사값만 G열에 입력. 실사 안 한 품목은 빈칸 = 판매계산 제외)
 *  ② 전표 미리보기: 판매·이동(중앙→수술방)=전일자, 창고→중앙 이동=오늘(부족수량), 환입
 *  ③ 전표 전송   : 미리보기 '대기' 행 전송 (전송된 항목은 '기전송'으로 중복 방지)
 *  ④ 재고 재점검 : 이카운트 실재고 재조회 → 중앙 기대재고(실사+이동-환입)와 대조
 *  ⑤ 마감 저장   : 오늘 전 품목 스냅샷을 [일별기록]에 저장
 *
 * 관리
 *  ⓪ 새 구조 초기 구축(1회) / ⑥ 과거 날짜탭 아카이브 / ⑦ API 테스트 / ⚙ API 설정
 *  (구) 날짜탭 방식 메뉴는 전환 기간 동안 하위 메뉴로 유지
 */

// ══════════════════════════ 설정 ══════════════════════════

var CONFIG = {
  MAIN_SHEET: '재고',          // (구) 부산점 단일 탭 이름 — '재고_지점명' 형식도 인식
  LOG_SHEET: '일별기록',
  ITEM_SHEET: '품목 정보',
  SETTINGS_SHEET: '설정',
  WHLIST_SHEET: '_창고목록',
  PREVIEW_SHEET: '_전표전송',
  CHECK_SHEET: '_재고점검',
  DEBUG_SHEET: '_API디버그',
  DATA_START_ROW: 3,

  // 기본 지점(부산점) — [설정] 탭이 없거나 지점을 못 찾을 때의 안전값 (재고조회 API로 검증됨)
  DEFAULT_BRANCH: {
    name: '부산점',
    cust: '부산점',
    emp: '33344',
    whSurgery: '플란치과_부산점_13층 수술방',
    whCentral: '플란치과_부산점_13층 중앙공급실(구매팀)',
    whStorage: '플란치과_부산점_구매팀 창고'
  },
  WH_CODES: {
    '플란치과_부산점_13층 수술방': '00041',
    '플란치과_부산점_13층 중앙공급실(구매팀)': '00032',
    '플란치과_부산점_13층 중앙공급실(보철)': '00060',
    '플란치과_부산점_13층 중앙공급실(수술)': '00068',
    '플란치과_부산점_구매팀 창고': '00039',
    '플란치과_일산점_수술방': '00087',
    '플란치과_일산점_중앙공급실(구매팀)': '00088',
    '플란치과_일산점_구매팀 창고': '00083'
  },

  EMP_CD: '33344',       // 담당자코드 기본값 (사원명 Cluade)
  VAT_RATE: 0.1,
  SALE_LIST_KEY: 'SaleList',
  TRANSFER_LIST_KEY: 'LocationTranList',
  TRANSFER_FROM_FIELD: 'WH_CD_F',
  TRANSFER_TO_FIELD: 'WH_CD_T',

  USAGE_WINDOW_DAYS: 14, // 사용량(1일) 계산 기간
  ORDER_ROUND_UNIT: 5,   // 발주수량 반올림 단위
  ARCHIVE_KEEP_DAYS: 7   // 아카이브 시 남겨둘 최근 날짜 탭 일수
};

// [재고] 탭 열 정의 (1-base)
var COL = {
  CAT: 1,      // A 중분류
  VENDOR: 2,   // B 거래처
  CODE: 3,     // C 품목코드
  NAME: 4,     // D 품목명
  ALLOW: 5,    // E 인가량
  PREV: 6,     // F 전일 중앙재고 (자동)
  COUNT: 7,    // G 오늘 실사(중앙) [입력]
  SALE: 8,     // H 판매 (수식 = F-G, 실사 시에만)
  NEED: 9,     // I 부족수량 (수식 = MAX(0, E-G))
  STORAGE: 10, // J 창고 실재고 (자동)
  SURGERY: 11, // K 수술방 실재고 (자동)
  RET: 12,     // L 환입 [입력]
  PURCHASE: 13,// M 구매입고 [입력]
  FAIL: 14,    // N 페일 [입력]
  USAGE: 15,   // O 사용량(1일) (자동: 일별기록 최근 14일 평균)
  DAYS: 16,    // P 사용예정일 [입력]
  REQ: 17,     // Q 필요수량 (수식 = O*P)
  ORDER: 18,   // R 발주수량 (수식)
  MEMO: 19     // S 비고
};
var LOG_HEADERS = ['일자', '지점', '품목코드', '품목명', '전일중앙', '실사중앙', '판매', '부족수량',
  '창고실재고', '수술방실재고', '환입', '구매입고', '페일', '사용량1일', '발주수량', '전표번호', '저장시각'];
// 설정 탭 열: A지점명 B판매거래처 C담당자코드 D수술방창고 E중앙공급실창고 F보관창고
var SETTING_HEADERS = ['지점명', '판매거래처코드', '담당자코드', '수술방(사용창고)', '중앙공급실 창고', '보관창고(대창고)'];

// ══════════════════════════ 메뉴 ══════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ 재고마감')
    .addItem('① 아침 준비 (전일재고 갱신+초기화)', 'morningPrep')
    .addItem('② 마감 전표 미리보기', 'makeSlipPreview')
    .addItem('③ 전표 전송', 'sendSlips')
    .addItem('④ 재고 재점검', 'checkInventory')
    .addItem('⑤ 마감 저장 (일별기록)', 'saveDailyLog')
    .addSeparator()
    .addItem('⓪ 새 구조 초기 구축 (최초 1회)', 'buildNewStructure')
    .addItem('⑥ 과거 날짜탭 아카이브', 'archiveOldTabs')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⑧ 지점 관리')
      .addItem('설정 탭 생성/열기', 'openSettings')
      .addItem('창고 목록 새로고침 (드롭다운 갱신)', 'refreshWarehouseList')
      .addItem('지점 재고탭 생성', 'createBranchStockTab'))
    .addItem('⑦ API 연결 테스트', 'testApi')
    .addItem('⚙ API 설정', 'setupApiKeys')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('(구) 날짜탭 방식')
      .addItem('오늘 탭 생성', 'createTodayTab')
      .addItem('마감재고만 다시 받기', 'refetchClosingStock'))
    .addToUi();
}

// ══════════════════════════ ⑧ 지점 관리 ══════════════════════════

/** [설정] 탭 생성(없으면) 후 열기. 부산/일산은 기본값 시드, 부평은 드롭다운으로 선택 */
function openSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SETTINGS_SHEET, 0);
    sheet.getRange(1, 1).setValue('지점별 설정 — 창고는 드롭다운에서 선택 (목록이 비었으면 "⑧ 지점 관리 > 창고 목록 새로고침" 실행). 재고탭 이름은 "재고_지점명" 형식으로 자동 연결됩니다.');
    sheet.getRange(2, 1, 1, SETTING_HEADERS.length).setValues([SETTING_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(2);
    sheet.getRange(3, 1, 3, 6).setValues([
      ['부산점', '부산점', CONFIG.EMP_CD, CONFIG.DEFAULT_BRANCH.whSurgery, CONFIG.DEFAULT_BRANCH.whCentral, CONFIG.DEFAULT_BRANCH.whStorage],
      ['일산점', '일산점', CONFIG.EMP_CD, '플란치과_일산점_수술방', '플란치과_일산점_중앙공급실(구매팀)', '플란치과_일산점_구매팀 창고'],
      ['부평점', '부평점', CONFIG.EMP_CD, '', '', '']
    ]);
    sheet.setColumnWidths(4, 3, 280);
    applyWhValidation_(ss, sheet);
  }
  sheet.showSheet();
  ss.setActiveSheet(sheet);
  SpreadsheetApp.getUi().alert('[설정] 탭입니다.\n· 지점 추가: 행을 추가해 지점명/거래처/창고를 입력\n· 창고 선택: D~F열 드롭다운 (목록 갱신은 "창고 목록 새로고침")\n· 판매거래처코드는 이카운트 거래처코드와 일치해야 합니다 (부산점은 검증됨)');
}

/** 이카운트에서 전체 창고 목록을 받아 [_창고목록]에 저장하고 설정 탭 드롭다운 갱신 */
function refreshWarehouseList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var rows = ecountFetchInventory(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd'));
  var wh = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['WH_CD']) || '').trim();
    var des = String(firstOf_(r, ['WH_DES']) || '').trim();
    if (cd && des) wh[des] = cd;
  });
  var names = Object.keys(wh).sort();
  if (!names.length) { ui.alert('창고 목록을 받지 못했습니다.'); return; }

  var sheet = ss.getSheetByName(CONFIG.WHLIST_SHEET);
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet(CONFIG.WHLIST_SHEET, ss.getSheets().length);
  sheet.getRange(1, 1, 1, 2).setValues([['창고코드', '창고명']]);
  sheet.getRange(2, 1, names.length, 2).setValues(names.map(function (n) { return [wh[n], n]; }));
  sheet.hideSheet();

  var settings = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (settings) applyWhValidation_(ss, settings);
  ui.alert('✅ 창고 ' + names.length + '개 수신 — [설정] 탭 창고 드롭다운이 갱신됐습니다.');
}

function applyWhValidation_(ss, settings) {
  var whList = ss.getSheetByName(CONFIG.WHLIST_SHEET);
  if (!whList || whList.getLastRow() < 2) return;
  var range = whList.getRange(2, 2, whList.getLastRow() - 1, 1);
  var rule = SpreadsheetApp.newDataValidation().requireValueInRange(range, true).setAllowInvalid(true).build();
  settings.getRange(3, 4, Math.max(settings.getLastRow() - 2, 10), 3).setDataValidation(rule);
}

/** 창고명 → 창고코드 맵 ([_창고목록] 우선, 없으면 CONFIG.WH_CODES) */
function loadWhMap_(ss) {
  var map = {};
  Object.keys(CONFIG.WH_CODES).forEach(function (k) { map[k] = CONFIG.WH_CODES[k]; });
  var sheet = ss.getSheetByName(CONFIG.WHLIST_SHEET);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0] && r[1]) map[String(r[1]).trim()] = String(r[0]).trim();
    });
  }
  return map;
}

/** [설정] 탭의 지점 목록 읽기 → {지점명: config} */
function getBranches_(ss) {
  var out = {};
  var d = CONFIG.DEFAULT_BRANCH;
  out[d.name] = { name: d.name, cust: d.cust, emp: d.emp, whSurgery: d.whSurgery, whCentral: d.whCentral, whStorage: d.whStorage };
  var sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (sheet && sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 6).getValues().forEach(function (r) {
      var name = String(r[0] || '').trim();
      if (!name) return;
      out[name] = {
        name: name, cust: String(r[1] || name).trim(), emp: String(r[2] || CONFIG.EMP_CD).trim(),
        whSurgery: String(r[3] || '').trim(), whCentral: String(r[4] || '').trim(), whStorage: String(r[5] || '').trim()
      };
    });
  }
  return out;
}

/** 현재 활성 시트에서 지점 판별: '재고_지점명' 또는 (구) '재고'=부산점 */
function branchFromActive_(ss) {
  var name = ss.getActiveSheet().getName();
  var branchName = null;
  if (name === CONFIG.MAIN_SHEET) branchName = CONFIG.DEFAULT_BRANCH.name;
  else if (name.indexOf('재고_') === 0) branchName = name.slice(3);
  if (!branchName) {
    throw new Error('지점 재고 탭([재고] 또는 [재고_지점명])을 연 상태에서 실행하세요.\n(현재 탭: ' + name + ')');
  }
  var b = getBranches_(ss)[branchName];
  if (!b) throw new Error('[설정] 탭에 "' + branchName + '" 지점이 없습니다. "⑧ 지점 관리 > 설정 탭"에서 추가하세요.');
  if (!b.whSurgery || !b.whCentral || !b.whStorage) {
    throw new Error('"' + branchName + '" 지점의 창고가 [설정] 탭에서 선택되지 않았습니다. (수술방/중앙공급실/보관창고)');
  }
  b.sheet = ss.getActiveSheet();
  return b;
}

/** 지점 재고탭 생성: 해당 지점 3창고에 재고가 있는 품목으로 시드 */
function createBranchStockTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var branches = getBranches_(ss);
  var names = Object.keys(branches);
  var res = ui.prompt('재고탭을 만들 지점명을 입력하세요.\n등록된 지점: ' + names.join(', '), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var bName = res.getResponseText().trim();
  var b = branches[bName];
  if (!b) { ui.alert('[설정] 탭에 "' + bName + '" 지점이 없습니다.'); return; }
  if (!b.whSurgery || !b.whCentral || !b.whStorage) { ui.alert('"' + bName + '" 지점의 창고를 [설정] 탭에서 먼저 선택하세요.'); return; }
  var tabName = '재고_' + bName;
  if (ss.getSheetByName(tabName)) { ui.alert('"' + tabName + '" 탭이 이미 있습니다.'); return; }

  // 해당 지점 창고에 재고 있는 품목 수집
  var rows = ecountFetchInventory(Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd'));
  var whSet = {};
  [b.whCentral, b.whStorage, b.whSurgery].forEach(function (w) { whSet[normalize_(w)] = true; });
  var codes = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['PROD_CD']) || '').trim();
    var wh = normalize_(String(firstOf_(r, ['WH_DES']) || ''));
    if (cd && whSet[wh] && Number(firstOf_(r, ['BAL_QTY']) || 0)) codes[cd] = firstOf_(r, ['PROD_DES']) || '';
  });
  var codeList = Object.keys(codes).sort();
  if (!codeList.length) { ui.alert('해당 지점 창고에 재고가 있는 품목이 없습니다. [설정]의 창고 선택을 확인하세요.'); return; }

  var itemInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[3] !== '' && r[3] != null) itemInfo[String(r[3])] = { cat: r[2], vendor: r[0], name: r[4] };
    });
  }
  var data = codeList.map(function (cd) {
    var info = itemInfo[cd] || {};
    return [info.cat || '', info.vendor || '', cd, info.name || codes[cd], '',
      '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  });
  buildStockTabFrame_(ss, tabName, data);
  ui.alert('✅ "' + tabName + '" 생성 완료 — 품목 ' + codeList.length + '건 (지점 창고 재고 기준)\n' +
    '· 인가량(E열)은 지점 기준에 맞게 직접 입력하세요.\n· 이 탭을 연 상태로 ①~⑤ 메뉴를 실행하면 ' + bName + ' 기준으로 동작합니다.');
}

/** 재고탭 공통 틀 생성 (헤더/수식/서식) — data: 19열 배열 */
function buildStockTabFrame_(ss, tabName, data) {
  var main = ss.insertSheet(tabName, 1);
  main.getRange(1, COL.PREV, 1, 4).setValues([['중앙공급실 (매일 실사)', '', '', '']]);
  main.getRange(1, COL.STORAGE, 1, 2).setValues([['실재고(자동)', '']]);
  main.getRange(1, COL.USAGE, 1, 4).setValues([['발주', '', '', '']]);
  main.getRange(2, 1, 1, 19).setValues([[
    '중분류', '거래처', '품목코드', '품목명', '인가량',
    '전일재고\n(자동)', '오늘 실사\n입력칸', '판매\n(수식)', '부족수량\n(수식)',
    '창고 실재고\n(자동)', '수술방 실재고\n(자동)',
    '환입\n입력칸', '구매입고\n입력칸', '페일\n입력칸',
    '사용량(1일)\n(자동)', '사용예정일\n입력칸', '필요수량\n(수식)', '발주수량\n(수식)', '비고'
  ]]);
  main.getRange(1, 1, 2, 19).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  main.setFrozenRows(2);
  main.setFrozenColumns(4);

  var n = data.length;
  var startRow = CONFIG.DATA_START_ROW;
  main.getRange(startRow, 1, n, 19).setValues(data);

  var fSale = [], fNeed = [], fReq = [], fOrder = [];
  for (var i = 0; i < n; i++) {
    var r = startRow + i;
    fSale.push(['=IF($G' + r + '="","",$F' + r + '-$G' + r + ')']);
    fNeed.push(['=IF($G' + r + '="","",MAX(0,N($E' + r + ')-$G' + r + '))']);
    fReq.push(['=IF(OR($O' + r + '="",$P' + r + '=""),"",$O' + r + '*$P' + r + ')']);
    fOrder.push(['=IF($Q' + r + '="","",MAX(0,ROUNDDOWN(($Q' + r + '-N($G' + r + ')-N($J' + r + '))/' + CONFIG.ORDER_ROUND_UNIT + ',0)*' + CONFIG.ORDER_ROUND_UNIT + '))']);
  }
  main.getRange(startRow, COL.SALE, n, 1).setFormulas(fSale);
  main.getRange(startRow, COL.NEED, n, 1).setFormulas(fNeed);
  main.getRange(startRow, COL.REQ, n, 1).setFormulas(fReq);
  main.getRange(startRow, COL.ORDER, n, 1).setFormulas(fOrder);

  var yellow = '#fff9c4', gray = '#f0f0f0';
  [COL.COUNT, COL.RET, COL.PURCHASE, COL.FAIL, COL.DAYS].forEach(function (c) {
    main.getRange(startRow, c, n, 1).setBackground(yellow);
  });
  [COL.PREV, COL.STORAGE, COL.SURGERY, COL.USAGE].forEach(function (c) {
    main.getRange(startRow, c, n, 1).setBackground(gray);
  });
  return main;
}

// ══════════════════════════ ⓪ 새 구조 초기 구축 ══════════════════════════

function buildNewStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  if (ss.getSheetByName(CONFIG.MAIN_SHEET)) {
    ui.alert('"' + CONFIG.MAIN_SHEET + '" 탭이 이미 있습니다. 초기 구축은 최초 1회만 실행하세요.');
    return;
  }

  // 품목 목록: 최신 날짜 탭에서 가져옴 (중분류/거래처/품목코드/품목명/인가량, 사용예정일)
  var latest = findLatestDailyTab(ss, new Date());
  if (!latest) { ui.alert('품목 목록을 가져올 기존 날짜 탭이 없습니다.'); return; }
  var src = latest.sheet;
  var srcLast = src.getLastRow();
  var srcData = src.getRange(3, 1, srcLast - 2, 28).getValues(); // A~AB

  var rows = [];
  srcData.forEach(function (r) {
    if (!r[3]) return; // D 품목코드 없는 행 제외
    rows.push([r[0] || '', r[2] || '', r[3], r[4] || '', r[5] || '',
      '', '', '', '', '', '', '', '', '', '', r[27] || '', '', '', '']);
  });
  var n = rows.length;
  buildStockTabFrame_(ss, CONFIG.MAIN_SHEET, rows);

  // 일별기록 탭
  if (!ss.getSheetByName(CONFIG.LOG_SHEET)) {
    var log = ss.insertSheet(CONFIG.LOG_SHEET, 2);
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    log.setFrozenRows(1);
  }

  ui.alert('✅ 새 구조 구축 완료\n' +
    '· [재고] 탭: 품목 ' + n + '건 (기준: "' + src.getName() + '" 탭)\n' +
    '· [일별기록] 탭 생성\n\n' +
    '다음: "① 아침 준비"를 실행해 전일재고를 채우세요.');
}

// ══════════════════════════ ① 아침 준비 ══════════════════════════

function morningPrep() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;

  var today = new Date();
  var prevDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  var rows = ecountFetchInventory(Utilities.formatDate(prevDate, 'Asia/Seoul', 'yyyyMMdd'));
  var bal = pivotBalance_(rows, b);

  var startRow = CONFIG.DATA_START_ROW;
  var lastRow = main.getLastRow();
  var n = lastRow - startRow + 1;
  if (n <= 0) { ui.alert('[재고] 탭에 품목이 없습니다.'); return; }
  var codes = main.getRange(startRow, COL.CODE, n, 1).getValues();

  // 사용량(1일): 일별기록 최근 USAGE_WINDOW_DAYS일 판매 합계 ÷ 실사일수 (해당 지점 기록만)
  var usage = computeUsage_(ss, b.name);

  var prevVals = [], storVals = [], surgVals = [], usageVals = [];
  codes.forEach(function (row) {
    var cd = String(row[0] || '');
    var b = bal[cd] || [0, 0, 0];
    prevVals.push([cd ? b[0] : '']);
    storVals.push([cd ? b[1] : '']);
    surgVals.push([cd ? b[2] : '']);
    usageVals.push([cd && usage[cd] != null ? usage[cd] : '']);
  });
  main.getRange(startRow, COL.PREV, n, 1).setValues(prevVals);
  main.getRange(startRow, COL.STORAGE, n, 1).setValues(storVals);
  main.getRange(startRow, COL.SURGERY, n, 1).setValues(surgVals);
  main.getRange(startRow, COL.USAGE, n, 1).setValues(usageVals);

  // 입력칸 초기화 (실사/환입/구매입고/페일)
  [COL.COUNT, COL.RET, COL.PURCHASE, COL.FAIL].forEach(function (c) {
    main.getRange(startRow, c, n, 1).clearContent();
  });

  ui.alert('✅ [' + b.name + '] 아침 준비 완료 (기준일: ' + Utilities.formatDate(prevDate, 'Asia/Seoul', 'M/d') + ' 마감)\n' +
    '· 전일 중앙재고 / 창고·수술방 실재고 자동 입력\n' +
    '· 실사·환입·구매입고·페일 입력칸 초기화\n' +
    '· 사용량(1일): 일별기록 최근 ' + CONFIG.USAGE_WINDOW_DAYS + '일 기준 재계산\n\n' +
    '이제 중앙공급실 실사값을 G열에 입력하세요. (실사 안 한 품목은 빈칸)');
}

/** API 응답 → 품목코드별 [중앙, 창고, 수술방] 잔고 (지점 창고 기준) */
function pivotBalance_(rows, b) {
  var slotMap = {};
  slotMap[normalize_(b.whCentral)] = 0;
  slotMap[normalize_(b.whStorage)] = 1;
  slotMap[normalize_(b.whSurgery)] = 2;
  var bal = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['PROD_CD']) || '').trim();
    var qty = Number(firstOf_(r, ['BAL_QTY']) || 0);
    if (!cd || !qty) return;
    var slot = slotMap[normalize_(String(firstOf_(r, ['WH_DES']) || ''))];
    if (slot == null) return;
    if (!bal[cd]) bal[cd] = [0, 0, 0];
    bal[cd][slot] += qty;
  });
  return bal;
}

/** 일별기록 최근 N일에서 품목별 1일 사용량(판매 합계 ÷ 기록된 날짜 수) 계산 — 해당 지점만 */
function computeUsage_(ss, branchName) {
  var log = ss.getSheetByName(CONFIG.LOG_SHEET);
  var usage = {};
  if (!log || log.getLastRow() < 2) return usage;
  var hasBranchCol = String(log.getRange(1, 2).getValue()) === '지점';
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.USAGE_WINDOW_DAYS);
  var cutoffYmd = Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyyMMdd');
  var data = log.getRange(2, 1, log.getLastRow() - 1, 7).getValues();
  var sum = {}, days = {};
  data.forEach(function (r) {
    var ymd = String(r[0]);
    if (ymd < cutoffYmd) return;
    var branch = hasBranchCol ? String(r[1]) : CONFIG.DEFAULT_BRANCH.name;
    if (branch !== branchName) return;
    var cd = String(r[hasBranchCol ? 2 : 1]);
    var saleVal = r[hasBranchCol ? 6 : 5];
    var sale = Number(saleVal);
    if (!cd || isNaN(sale) || saleVal === '') return;
    sum[cd] = (sum[cd] || 0) + sale;
    if (!days[cd]) days[cd] = {};
    days[cd][ymd] = true;
  });
  Object.keys(sum).forEach(function (cd) {
    var d = Object.keys(days[cd]).length;
    if (d > 0) usage[cd] = Math.round(sum[cd] / d * 100) / 100;
  });
  return usage;
}

// ══════════════════════════ ② 전표 미리보기 ══════════════════════════

/**
 * 판매·이동(중앙→수술방) = 전일자(일별기록 마지막 저장일, 없으면 어제), 수량 = H 판매
 * 이동(창고→중앙) = 오늘, 수량 = I 부족수량 / 환입 = 오늘, 중앙→창고, 수량 = L
 */
function makeSlipPreview() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;

  var today = new Date();
  var ymdToday = Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd');
  var ymdPrev = lastLogDate_(ss, b.name) || Utilities.formatDate(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1), 'Asia/Seoul', 'yyyyMMdd');
  if (ymdPrev >= ymdToday) ymdPrev = Utilities.formatDate(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1), 'Asia/Seoul', 'yyyyMMdd');

  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  var data = main.getRange(startRow, 1, n, 19).getValues();

  var itemInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[3] !== '' && r[3] != null) itemInfo[String(r[3])] = { price: Number(r[7]) || 0 };
    });
  }

  var out = [];
  data.forEach(function (r) {
    var code = r[COL.CODE - 1], name = r[COL.NAME - 1];
    if (!code) return;
    var sale = Number(r[COL.SALE - 1]) || 0;
    var need = Number(r[COL.NEED - 1]) || 0;
    var ret = Number(r[COL.RET - 1]) || 0;
    if (sale > 0) {
      out.push([b.name, '판매', ymdPrev, b.whSurgery, '', code, name, sale, (itemInfo[code] || {}).price || 0, '대기', '']);
      out.push([b.name, '이동', ymdPrev, b.whCentral, b.whSurgery, code, name, sale, '', '대기', '']);
    }
    if (need > 0) out.push([b.name, '이동', ymdToday, b.whStorage, b.whCentral, code, name, need, '', '대기', '']);
    if (ret > 0) out.push([b.name, '환입', ymdToday, b.whCentral, b.whStorage, code, name, ret, '', '대기', '']);
  });

  if (!out.length) { ui.alert('전송할 내역이 없습니다. (실사값 입력 후 실행하세요)'); return; }

  // 이미 전송된 키(중복 방지)
  var sentKeys = getSentKeys_();
  var dup = 0;
  out.forEach(function (r) {
    var key = slipKey_(r);
    if (sentKeys[key]) { r[9] = '기전송(자동 제외)'; dup++; }
  });

  var sheet = ss.getSheetByName(CONFIG.PREVIEW_SHEET);
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet(CONFIG.PREVIEW_SHEET, ss.getSheets().length);
  sheet.getRange(1, 1).setValue('[' + b.name + '] 전송 전 검토용 — 판매·이동(중앙→수술방)은 전일자(' + ymdPrev + '), 창고→중앙 이동·환입은 오늘(' + ymdToday + '). 수량 수정 가능, 빼려면 행 삭제 또는 수량 0. 검토 후 "③ 전표 전송" 실행');
  sheet.getRange(2, 1, 1, 11).setValues([['지점', '구분', '일자', '보내는창고/판매창고', '받는창고', '품목코드', '품목명', '수량', '단가(판매만)', '상태', '전표결과']]).setFontWeight('bold');
  sheet.getRange(3, 1, out.length, 11).setValues(out);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  var cnt = { '판매': 0, '이동': 0, '환입': 0 };
  out.forEach(function (r) { if (r[9] === '대기') cnt[r[1]]++; });
  ui.alert('[' + b.name + '] 전표 초안 생성 완료 — 판매 ' + cnt['판매'] + '건, 이동 ' + cnt['이동'] + '건, 환입 ' + cnt['환입'] + '건' +
    (dup ? '\n(기전송 ' + dup + '건 자동 제외)' : '') +
    '\n"' + CONFIG.PREVIEW_SHEET + '" 탭에서 검토·수정 후 "③ 전표 전송"을 실행하세요.');
}

// ══════════════════════════ ③ 전표 전송 ══════════════════════════

function sendSlips() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(CONFIG.PREVIEW_SHEET);
  if (!sheet || sheet.getLastRow() < 3) { ui.alert('먼저 "② 마감 전표 미리보기"를 실행하세요.'); return; }

  var lastRow = sheet.getLastRow();
  var rows = sheet.getRange(3, 1, lastRow - 2, 11).getValues();
  var pend = [];
  rows.forEach(function (r, i) {
    if (String(r[9]).trim() === '대기' && Number(r[7]) > 0 && r[5]) pend.push({ i: i, r: r });
  });
  if (!pend.length) { ui.alert('전송할 "대기" 상태 행이 없습니다.'); return; }

  var cnt = { '판매': 0, '이동': 0, '환입': 0 };
  pend.forEach(function (p) { cnt[p.r[1]]++; });
  var branchNames = {};
  pend.forEach(function (p) { branchNames[p.r[0]] = 1; });
  var go = ui.alert('이카운트로 전송합니다 (' + Object.keys(branchNames).join(', ') + '):\n· 판매 ' + cnt['판매'] + '건\n· 이동 ' + cnt['이동'] + '건\n· 환입 ' + cnt['환입'] + '건\n\n진행할까요?', ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  var branches = getBranches_(ss);
  var whMap = loadWhMap_(ss);
  var whCd = function (name) { return whMap[String(name).trim()] || ''; };
  var branchOf = function (p) { return branches[p.r[0]] || CONFIG.DEFAULT_BRANCH; };
  var batches = [];

  // 판매: 지점별로 한 전표씩 (공급가액 = 수량×단가, 부가세 = 공급가액×10%, 담당자 기록)
  Object.keys(branchNames).forEach(function (bName) {
    var saleRows = pend.filter(function (p) { return p.r[1] === '판매' && p.r[0] === bName; });
    if (!saleRows.length) return;
    batches.push({
      kind: 'sale', listKey: CONFIG.SALE_LIST_KEY, label: '판매(' + bName + ')', rows: saleRows,
      bulk: saleRows.map(function (p) {
        var bb = branchOf(p);
        var qty = Number(p.r[7]) || 0, price = Number(p.r[8]) || 0;
        var supply = Math.round(qty * price);
        return {
          IO_DATE: String(p.r[2]), UPLOAD_SER_NO: '1',
          CUST: bb.cust, EMP_CD: bb.emp, WH_CD: whCd(p.r[3]),
          PROD_CD: String(p.r[5]), QTY: String(qty), PRICE: String(price),
          SUPPLY_AMT: String(supply), VAT_AMT: String(Math.round(supply * CONFIG.VAT_RATE))
        };
      })
    });
  });

  // 이동/환입: 지점·방향별로 같은 순번(전표 묶음)
  var moveRows = pend.filter(function (p) { return p.r[1] !== '판매'; });
  if (moveRows.length) {
    var dirSer = {}, serial = 0;
    batches.push({
      kind: 'transfer', listKey: CONFIG.TRANSFER_LIST_KEY, label: '이동/환입', rows: moveRows,
      bulk: moveRows.map(function (p) {
        var dir = p.r[0] + '|' + p.r[2] + '|' + p.r[3] + '>' + p.r[4];
        if (!dirSer[dir]) dirSer[dir] = String(++serial);
        var row = { IO_DATE: String(p.r[2]), UPLOAD_SER_NO: dirSer[dir], EMP_CD: branchOf(p).emp, PROD_CD: String(p.r[5]), QTY: String(p.r[7]) };
        row[CONFIG.TRANSFER_FROM_FIELD] = whCd(p.r[3]);
        row[CONFIG.TRANSFER_TO_FIELD] = whCd(p.r[4]);
        return row;
      })
    });
  }

  // 창고코드 누락 검사 (전송 전 차단)
  var missing = [];
  batches.forEach(function (b2) {
    b2.bulk.forEach(function (row, i) {
      if (b2.kind === 'sale' && !row.WH_CD) missing.push(b2.rows[i].r[3]);
      if (b2.kind === 'transfer' && (!row[CONFIG.TRANSFER_FROM_FIELD] || !row[CONFIG.TRANSFER_TO_FIELD])) missing.push(b2.rows[i].r[3] + '/' + b2.rows[i].r[4]);
    });
  });
  if (missing.length) {
    ui.alert('창고코드를 찾지 못한 행이 있어 중단합니다:\n' + missing.filter(function (v, i, a) { return a.indexOf(v) === i; }).join('\n') +
      '\n\n"⑧ 지점 관리 > 창고 목록 새로고침"을 실행한 뒤 다시 시도하세요.');
    return;
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM/dd HH:mm');
  var summary = [];
  var sentKeys = getSentKeys_();

  batches.forEach(function (b) {
    var res = relaySave_(b.kind, b.listKey, b.bulk);
    var okMsg = '전송완료 ' + now, failMsg = null;
    var result = res.result || {};
    var d = result.Data;
    if (!res.ok) failMsg = '오류: ' + String(res.msg).slice(0, 80);
    else if (String(result.Status || '') !== '200' || !d) {
      var errs = (result.Errors || []).map(function (e) { return e.Message; }).join('; ');
      failMsg = '오류: Status ' + (result.Status || '?') + (errs ? ' — ' + errs : '') + ' ("' + CONFIG.DEBUG_SHEET + '" 시트 확인)';
    } else if (Number(d.FailCnt || 0) > 0) {
      var detail = ((d.ResultDetails || []).filter(function (x) { return x && x.IsSuccess === false; })[0] || {}).TotalError || '';
      failMsg = '오류: 이카운트 ' + d.FailCnt + '건 실패 — ' + String(detail).slice(0, 60);
    }
    b.rows.forEach(function (p) {
      rows[p.i][9] = failMsg || okMsg;
      rows[p.i][10] = failMsg ? '' : JSON.stringify((d || {}).SlipNos || '').slice(0, 60);
      if (!failMsg) sentKeys[slipKey_(p.r)] = 1;
    });
    summary.push('· ' + b.label + ': ' + (failMsg || (b.rows.length + '건 성공, 전표 ' + JSON.stringify((d || {}).SlipNos || []))));
  });

  sheet.getRange(3, 10, rows.length, 2).setValues(rows.map(function (r) { return [r[9], r[10]]; }));
  putSentKeys_(sentKeys);
  ui.alert('전송 결과\n' + summary.join('\n') + '\n\n"④ 재고 재점검"으로 실재고를 확인하세요.');
}

function slipKey_(r) {
  return [r[0], r[1], r[2], r[3], r[4], r[5], r[7]].join('|');
}
function getSentKeys_() {
  try { return JSON.parse(PropertiesService.getDocumentProperties().getProperty('SENT_KEYS') || '{}'); }
  catch (e) { return {}; }
}
function putSentKeys_(keys) {
  var ks = Object.keys(keys);
  if (ks.length > 3000) ks.slice(0, ks.length - 3000).forEach(function (k) { delete keys[k]; });
  PropertiesService.getDocumentProperties().setProperty('SENT_KEYS', JSON.stringify(keys));
}

function relaySave_(kind, listKey, bulk) {
  var relay = getRelayProps_();
  wakeRelay_(relay);
  var res = UrlFetchApp.fetch(relay.url + '/api/ecount/save', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Relay-Token': relay.token },
    payload: JSON.stringify({ kind: kind, list_key: listKey, rows: bulk }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  logDebug_(relay.url + '/api/ecount/save [' + kind + ']', { count: bulk.length, sample: bulk[0] }, code, text);
  var json;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, msg: 'HTTP ' + code + ' 응답 해석 실패' }; }
  if (code !== 200 || !json.ok) return { ok: false, msg: json.msg || ('HTTP ' + code) };
  return { ok: true, result: json.result };
}

// ══════════════════════════ ④ 재고 재점검 ══════════════════════════

/**
 * 이카운트 실재고(오늘 기준) 재조회 → [재고] 탭의 창고/수술방 열 갱신 +
 * 중앙 기대재고(실사 + 창고→중앙 이동 - 환입)와 API 중앙 실재고 대조.
 */
function checkInventory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;

  var ymd = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var apiRows = ecountFetchInventory(ymd);
  var bal = pivotBalance_(apiRows, b);

  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  var data = main.getRange(startRow, 1, n, 19).getValues();

  var report = [];
  var storVals = [], surgVals = [];
  data.forEach(function (r) {
    var code = String(r[COL.CODE - 1] || '');
    var b = bal[code] || [0, 0, 0];
    storVals.push([code ? b[1] : '']);
    surgVals.push([code ? b[2] : '']);
    if (!code) return;
    var counted = r[COL.COUNT - 1];
    if (counted === '' || counted == null) return; // 오늘 실사한 품목만 점검
    var expected = Number(counted) + (Number(r[COL.NEED - 1]) || 0) - (Number(r[COL.RET - 1]) || 0);
    var actual = b[0];
    if (Math.abs(expected - actual) > 0.0001) {
      report.push([code, r[COL.NAME - 1], Number(counted), Number(r[COL.NEED - 1]) || 0,
        Number(r[COL.RET - 1]) || 0, expected, actual, actual - expected]);
    }
  });

  // 창고/수술방 실재고 최신화
  main.getRange(startRow, COL.STORAGE, n, 1).setValues(storVals);
  main.getRange(startRow, COL.SURGERY, n, 1).setValues(surgVals);

  var sheet = ss.getSheetByName(CONFIG.CHECK_SHEET);
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet(CONFIG.CHECK_SHEET, ss.getSheets().length);
  sheet.getRange(1, 1).setValue('[' + b.name + '] 중앙공급실 재고 점검 (' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM/dd HH:mm') + ') — 기대재고 = 실사 + 창고→중앙이동 − 환입');
  sheet.getRange(2, 1, 1, 8).setValues([['품목코드', '품목명', '실사', '이동(부족보충)', '환입', '기대재고', 'ERP 실재고', '차이']]).setFontWeight('bold');
  if (report.length) sheet.getRange(3, 1, report.length, 8).setValues(report);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  ui.alert(report.length
    ? '⚠ [' + b.name + '] 차이 품목 ' + report.length + '건 — "' + CONFIG.CHECK_SHEET + '" 탭을 확인하세요.\n(전표 미전송/수량 차이/타 창고 이동 여부 확인)'
    : '✅ [' + b.name + '] 점검 완료 — 실사한 품목의 중앙 재고가 이카운트와 모두 일치합니다.');
}

// ══════════════════════════ ⑤ 마감 저장 ══════════════════════════

function saveDailyLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;
  var log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) { ui.alert('[일별기록] 탭이 없습니다. "⓪ 새 구조 초기 구축"을 먼저 실행하세요.'); return; }
  migrateLogBranchCol_(log);

  var ymd = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');

  // 같은 날+같은 지점 중복 저장 방지 (재저장 시 기존 기록 삭제 후 저장)
  var lastLog = log.getLastRow();
  if (lastLog > 1) {
    var keys = log.getRange(2, 1, lastLog - 1, 2).getValues(); // 일자, 지점
    var todayRows = [];
    keys.forEach(function (r, i) { if (String(r[0]) === ymd && String(r[1]) === b.name) todayRows.push(i + 2); });
    if (todayRows.length) {
      var go = ui.alert('오늘(' + ymd + ') [' + b.name + '] 기록 ' + todayRows.length + '건이 이미 있습니다.\n삭제하고 현재 값으로 다시 저장할까요?', ui.ButtonSet.YES_NO);
      if (go !== ui.Button.YES) return;
      for (var i = todayRows.length - 1; i >= 0; i--) log.deleteRow(todayRows[i]);
    }
  }

  // 오늘 전표번호 모음 (_전표전송 탭 K열)
  var slipNos = '';
  var prev = ss.getSheetByName(CONFIG.PREVIEW_SHEET);
  if (prev && prev.getLastRow() > 2) {
    var uniq = {};
    prev.getRange(3, 11, prev.getLastRow() - 2, 1).getValues().forEach(function (r) {
      if (r[0]) uniq[String(r[0])] = 1;
    });
    slipNos = Object.keys(uniq).join(' ');
  }

  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  var data = main.getRange(startRow, 1, n, 19).getValues();
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  var out = [];
  data.forEach(function (r) {
    var code = r[COL.CODE - 1];
    if (!code) return;
    out.push([ymd, b.name, code, r[COL.NAME - 1],
      r[COL.PREV - 1], r[COL.COUNT - 1], r[COL.SALE - 1], r[COL.NEED - 1],
      r[COL.STORAGE - 1], r[COL.SURGERY - 1],
      r[COL.RET - 1], r[COL.PURCHASE - 1], r[COL.FAIL - 1],
      r[COL.USAGE - 1], r[COL.ORDER - 1], slipNos, now]);
  });
  if (!out.length) { ui.alert('저장할 데이터가 없습니다.'); return; }
  log.getRange(log.getLastRow() + 1, 1, out.length, LOG_HEADERS.length).setValues(out);

  ui.alert('✅ [' + b.name + '] 마감 저장 완료 — [일별기록]에 ' + out.length + '건 기록 (' + ymd + ')\n' +
    '과거 이력은 [일별기록] 탭에서 일자/지점/품목으로 필터해 확인하세요.');
}

/** 일별기록에 지점 열이 없으면(B1 != '지점') 열 삽입 + 기존 기록은 부산점으로 채움 */
function migrateLogBranchCol_(log) {
  if (String(log.getRange(1, 2).getValue()) === '지점') return;
  log.insertColumnAfter(1);
  log.getRange(1, 2).setValue('지점').setFontWeight('bold');
  var last = log.getLastRow();
  if (last > 1) {
    var fill = [];
    for (var i = 0; i < last - 1; i++) fill.push([CONFIG.DEFAULT_BRANCH.name]);
    log.getRange(2, 2, last - 1, 1).setValues(fill);
  }
}

/** 일별기록의 마지막 저장 일자(yyyyMMdd) — 해당 지점 기준 */
function lastLogDate_(ss, branchName) {
  var log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log || log.getLastRow() < 2) return null;
  var hasBranchCol = String(log.getRange(1, 2).getValue()) === '지점';
  var rows = log.getRange(2, 1, log.getLastRow() - 1, 2).getValues();
  var max = null;
  rows.forEach(function (r) {
    var v = String(r[0]);
    var branch = hasBranchCol ? String(r[1]) : CONFIG.DEFAULT_BRANCH.name;
    if (branchName && branch !== branchName) return;
    if (/^\d{8}$/.test(v) && (!max || v > max)) max = v;
  });
  return max;
}

// ══════════════════════════ ⑥ 과거 날짜탭 아카이브 ══════════════════════════

function archiveOldTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var today = new Date();
  var cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - CONFIG.ARCHIVE_KEEP_DAYS);

  var targets = [];
  ss.getSheets().forEach(function (sheet) {
    var m = sheet.getName().match(/^(\d{1,2}\/\d{1,2})( 마감 재고)?$/);
    if (!m) return;
    var d = dateForTabName(m[1], today);
    if (d && d.getTime() < cutoff.getTime()) targets.push(sheet.getName());
  });
  if (!targets.length) { ui.alert('아카이브할 오래된 날짜 탭이 없습니다.'); return; }

  var go = ui.alert('과거 날짜 탭 ' + targets.length + '개를 아카이브합니다.\n\n' +
    '1) 전체 파일 사본을 "아카이브_" 이름으로 생성 (모든 탭 보존)\n' +
    '2) 이 파일에서 최근 ' + CONFIG.ARCHIVE_KEEP_DAYS + '일 이전 날짜 탭 삭제\n\n진행할까요? (수 분 걸릴 수 있음)', ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  var archiveName = '아카이브_' + ss.getName() + '_' + Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd');
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(archiveName);

  var deleted = 0;
  targets.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) { ss.deleteSheet(sheet); deleted++; }
  });

  ui.alert('✅ 아카이브 완료\n· 사본: "' + archiveName + '" (드라이브에 생성, 모든 탭 보존)\n· 이 파일에서 ' + deleted + '개 탭 삭제 — 파일이 가벼워졌습니다.\n\n사본 링크: ' + copy.getUrl());
}

// ══════════════════════════ (구) 날짜탭 방식 — 전환 기간용 ══════════════════════════

function createTodayTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var today = new Date();
  var todayName = tabNameForDate(today);

  if (ss.getSheetByName(todayName)) {
    ui.alert('이미 "' + todayName + '" 탭이 있습니다. 삭제 후 다시 실행하세요.');
    return;
  }
  var latest = findLatestDailyTab(ss, today);
  if (!latest) { ui.alert('복사할 이전 날짜 탭을 찾지 못했습니다.'); return; }
  var prevSheet = latest.sheet;
  var closingName = prevSheet.getName() + ' 마감 재고';

  var apiOk = false;
  try {
    buildClosingSheet(ss, latest.date, closingName);
    apiOk = true;
  } catch (e) {
    var existing = ss.getSheetByName(closingName);
    var msg = '이카운트 API 호출 실패:\n' + e.message + '\n\n';
    if (existing) {
      var go = ui.alert(msg + '기존 "' + closingName + '" 탭을 그대로 사용해 오늘 탭을 만들까요?', ui.ButtonSet.YES_NO);
      if (go !== ui.Button.YES) return;
    } else { ui.alert(msg + '"' + closingName + '" 탭이 없어 중단합니다.'); return; }
  }

  var closingCols;
  try { closingCols = resolveClosingCols_(ss, closingName); }
  catch (e) { ui.alert(e.message); return; }

  var newSheet = prevSheet.copyTo(ss).setName(todayName);
  ss.setActiveSheet(newSheet);
  ss.moveActiveSheet(prevSheet.getIndex() + 1);
  newSheet.showSheet();

  var lastRow = newSheet.getLastRow();
  var startRow = CONFIG.DATA_START_ROW;
  var n = lastRow - startRow + 1;
  if (n > 0) {
    var itemCodes = newSheet.getRange(startRow, 4, n, 1).getValues();
    [{ dailyCol: 'G', warehouse: CONFIG.WH_CENTRAL }, { dailyCol: 'M', warehouse: CONFIG.WH_STORAGE }].forEach(function (m) {
      var col = closingCols[m.warehouse];
      var formulas = itemCodes.map(function (row, i) {
        if (!row[0]) return [''];
        var r = startRow + i;
        return ["=iferror(XLOOKUP($D" + r + ",'" + closingName + "'!$A:$A,'" + closingName + "'!$" + col + ":$" + col + "),0)"];
      });
      newSheet.getRange(m.dailyCol + startRow + ':' + m.dailyCol + lastRow).setFormulas(formulas);
    });
    ['P', 'Q', 'R', 'S', 'V'].forEach(function (col) {
      newSheet.getRange(col + startRow + ':' + col + lastRow).clearContent();
    });
  }
  ui.alert('"' + todayName + '" 탭 생성 완료. (구 방식)\n· 전일재고 참조: ' + closingName + (apiOk ? ' (API 자동 수신)' : ' (기존 탭 사용)'));
}

function refetchClosingStock() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('마감재고를 받을 날짜를 입력하세요 (예: 8/13 또는 20260813)', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var raw = res.getResponseText().trim();
  var date;
  if (/^\d{8}$/.test(raw)) date = new Date(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8)));
  else date = dateForTabName(raw, new Date());
  if (!date) { ui.alert('날짜를 해석할 수 없습니다: ' + raw); return; }
  var closingName = tabNameForDate(date) + ' 마감 재고';
  try {
    var count = buildClosingSheet(ss, date, closingName);
    ui.alert('"' + closingName + '" 갱신 완료 (품목 ' + count + '건).');
  } catch (e) { ui.alert('실패: ' + e.message); }
}

function resolveClosingCols_(ss, closingName) {
  var sheet = ss.getSheetByName(closingName);
  if (!sheet) throw new Error('"' + closingName + '" 탭을 찾을 수 없습니다.');
  var headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  [CONFIG.WH_CENTRAL, CONFIG.WH_STORAGE].forEach(function (wh) {
    var idx = -1;
    for (var i = 0; i < headers.length; i++) {
      if (normalize_(headers[i]) === normalize_(wh)) { idx = i; break; }
    }
    if (idx < 0) throw new Error('"' + closingName + '" 헤더에서 창고 "' + wh + '"를 찾지 못했습니다.');
    map[wh] = columnLetter_(idx + 1);
  });
  return map;
}

function buildClosingSheet(ss, baseDate, closingName) {
  var rows = ecountFetchInventory(Utilities.formatDate(baseDate, 'Asia/Seoul', 'yyyyMMdd'));
  var whNames = ['플란치과_부산점_13층 수술방', '플란치과_부산점_13층 중앙공급실(구매팀)',
    '플란치과_부산점_13층 중앙공급실(보철)', '플란치과_부산점_13층 중앙공급실(수술)', '플란치과_부산점_구매팀 창고'];
  var whCol = {};
  whNames.forEach(function (nm, i) { whCol[normalize_(nm)] = i; });

  var itemInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[3] !== '' && r[3] != null) itemInfo[String(r[3])] = { name: r[4], size: r[5], unit: r[6], price: r[7], cat1: r[1], cat2: r[2] };
    });
  }
  var items = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['PROD_CD']) || '').trim();
    var qty = Number(firstOf_(r, ['BAL_QTY']) || 0);
    if (!cd || !qty) return;
    var col = whCol[normalize_(String(firstOf_(r, ['WH_DES']) || ''))];
    if (col == null) return;
    if (!items[cd]) items[cd] = { qty: [null, null, null, null, null], des: firstOf_(r, ['PROD_DES']) || '' };
    items[cd].qty[col] = (items[cd].qty[col] || 0) + qty;
  });
  var codes = Object.keys(items).sort();
  if (!codes.length) throw new Error('API 응답에 재고 데이터가 없습니다.');
  var out = [];
  codes.forEach(function (cd) {
    var it = items[cd], info = itemInfo[cd] || {};
    var sum = it.qty.reduce(function (a, b) { return a + (b || 0); }, 0);
    out.push([cd, info.name || it.des, info.size || '', info.unit || '', sum,
      it.qty[0], it.qty[1], it.qty[2], it.qty[3], it.qty[4], info.price || '', info.cat1 || '', info.cat2 || '']);
  });
  var sheet = ss.getSheetByName(closingName);
  if (sheet) sheet.clearContents();
  else sheet = ss.insertSheet(closingName, ss.getSheets().length);
  sheet.getRange(1, 1).setValue('회사명 : 주식회사 플란랩');
  sheet.getRange(2, 1, 1, 13).setValues([['품목코드', '품목명', '규격', '단위', '합계',
    whNames[0], whNames[1], whNames[2], whNames[3], whNames[4], '입고단가', '대분류', '중분류']]);
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
  ui.alert('저장 완료. "⑦ API 연결 테스트"로 확인하세요.');
}

function getRelayProps_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('RELAY_URL'), token = p.getProperty('RELAY_TOKEN');
  if (!url || !token) throw new Error('중계 서버가 설정되지 않았습니다. "⚙ API 설정"을 먼저 실행하세요.');
  return { url: url, token: token };
}

function wakeRelay_(relay) {
  for (var i = 0; i < 8; i++) {
    try {
      var res = UrlFetchApp.fetch(relay.url + '/api/ecount/ping', {
        headers: { 'X-Relay-Token': relay.token }, muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) return;
      if (code === 401) throw new Error('중계 토큰이 서버와 일치하지 않습니다. "⚙ API 설정"을 확인하세요.');
    } catch (e) {
      if (String(e.message).indexOf('중계 토큰') === 0) throw e;
    }
    Utilities.sleep(15000);
  }
  throw new Error('중계 서버가 응답하지 않습니다 (2분 대기 초과). Render 서비스 상태를 확인하세요.');
}

function ecountFetchInventory(baseDateYmd) {
  var relay = getRelayProps_();
  wakeRelay_(relay);
  var url = relay.url + '/api/ecount/inventory';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
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
      whSet[(firstOf_(r, ['WH_CD']) || '') + ' : ' + (firstOf_(r, ['WH_DES']) || '')] = true;
    });
    ui.alert('✅ 연결 성공\n오늘 기준 재고 행 수: ' + rows.length +
      '\n\n창고 목록:\n' + Object.keys(whSet).sort().join('\n'));
  } catch (e) {
    ui.alert('❌ 실패: ' + e.message);
  }
}

function logDebug_(url, payload, code, text) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.DEBUG_SHEET) || ss.insertSheet(CONFIG.DEBUG_SHEET);
    var safePayload = JSON.stringify(payload).replace(/"API_CERT_KEY":"[^"]*"/, '"API_CERT_KEY":"***"');
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, 4).setValues([[new Date(), url.replace(/SESSION_ID=[^&]*/, 'SESSION_ID=***'), safePayload, String(code) + ' | ' + text.slice(0, 45000)]]);
    if (sheet.getLastRow() > 30) sheet.deleteRows(31, sheet.getLastRow() - 30);
    sheet.hideSheet();
  } catch (e) { /* 무시 */ }
}

// ══════════════════════════ 날짜/탭 유틸 ══════════════════════════
// 날짜 탭 'M/D' (예: 8/13), 마감 탭 'M/D 마감 재고'

function tabNameForDate(d) {
  return String(d.getMonth() + 1) + '/' + String(d.getDate());
}

function dateForTabName(name, refDate) {
  var m = String(name).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  var month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  var date = new Date(refDate.getFullYear(), month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (date.getTime() > refDate.getTime()) return null;
  return date;
}

function findLatestDailyTab(ss, today) {
  var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var best = null;
  ss.getSheets().forEach(function (sheet) {
    var d = dateForTabName(sheet.getName(), new Date(todayStart.getTime() - 1));
    if (d && (!best || d.getTime() > best.date.getTime())) best = { sheet: sheet, date: d };
  });
  return best;
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

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
