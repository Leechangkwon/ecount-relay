/**
 * ⚡ 데일리 재고 마감 자동화 v2 (부산점) — 단일 탭 + 일별기록 구조
 *
 * 탭 구성
 *  [재고_지점명] : 지점별 매일 작업 탭 (날짜 탭 복제 없음). 예: 재고_부산점, 재고_일산점
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
  MAIN_SHEET: '재고',          // (구) 부산점 탭 이름 — 발견 시 '재고_부산점'으로 자동 개명. 현재 규칙: '재고_지점명'
  LOG_SHEET: '일별기록',
  ITEM_SHEET: '품목 정보',
  SETTINGS_SHEET: '설정',
  WHLIST_SHEET: '_창고목록',
  PREVIEW_SHEET: '_전표전송',
  CHECK_SHEET: '_재고점검',
  MAP_SHEET: '코드매핑',       // 구코드 → 대표코드 매핑 (같은 실물이 두 코드로 등록된 경우)
  PO_SHEET: '_발주서',         // 이카운트 발주계획 웹자료올리기 양식 출력
  COUNT_SHEET: '_실사리스트',  // 실사용 정렬 리스트 (계열·직경·길이 순)
  PO_TRADE_TYPE: '21',        // 거래유형 (21 = 부가세율 적용)
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

  USAGE_WINDOW_DAYS: 30, // 일사용량 계산 기간 (최근 30일 판매)
  USAGE_MIN_DAYS: 14,    // 일별기록이 이 일수 미만이면 Supabase 수불부(월 usage_qty÷30)로 대체
  ORDER_ROUND_UNIT: 5,   // 발주수량 반올림 단위
  DEFAULT_COVER_DAYS: 4, // 발주 커버일수 기본값 (월·수·금 발주, 금→화 입고 = 4일치 필요)
  ORDER_LOOKUP_DAYS_KEY: 'COVER_DAYS',
  // Supabase (새 ERP 동기화 DB) — 수불부 사용량 대체 소스. 값은 ⚙ API 설정에서 스크립트 속성에 저장
  SB_TABLE: 'stock_ledger_sync',
  SB_BRANCH_NAME: { '부산점': '부산', '부평점': '부평', '일산점': '일산' }, // 시트 지점명 → DB branch_name
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
  DAYS: 16,    // P 발주 커버일수 [입력] — 기본 4, 연휴 전엔 늘려서 발주
  REQ: 17,     // Q 목표재고 (수식 = O*P)
  ORDER: 18,   // R 발주수량 (수식 = MAX(0, Q − 중앙실재고 − 창고실재고, 창고인가량 − 창고실재고), 5단위 올림)
  MEMO: 19,    // S 비고
  WH_ALLOW: 20 // T 창고 인가량 [입력] — 발주 하한선(창고 최소 유지량)
};
var LOG_HEADERS = ['일자', '지점', '품목코드', '품목명', '전일중앙', '실사중앙', '판매', '부족수량',
  '창고실재고', '수술방실재고', '환입', '구매입고', '페일', '사용량1일', '발주수량', '전표번호', '저장시각'];
// 설정 탭 열: A지점명 B판매거래처 C담당자코드 D수술방창고 E중앙공급실창고 F보관창고
var SETTING_HEADERS = ['지점명', '판매거래처코드', '담당자코드', '수술방(사용창고)', '중앙공급실 창고', '보관창고(대창고)', '발주커버일수'];

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
    .addItem('⑦ 사용안내 탭 만들기/갱신', 'buildGuideSheet')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⑧ 지점 관리')
      .addItem('설정 탭 생성/열기', 'openSettings')
      .addItem('창고 목록 새로고침 (드롭다운 갱신)', 'refreshWarehouseList')
      .addItem('지점 재고탭 생성', 'createBranchStockTab')
      .addItem('재고 탭 이름 정리 (재고 → 재고_부산점)', 'renameLegacyStockTab'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⑨ 코드매핑 (구코드↔신코드)')
      .addItem('매핑 초안 자동 생성 / 열기', 'buildCodeMapping')
      .addItem('재고 탭에 매핑 적용 (구코드 행 합치기)', 'applyCodeMappingToStockTab'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⑩ 발주·인가량')
      .addItem('발주서 양식 생성 (_발주서 탭 → 이카운트 웹자료올리기)', 'buildPurchaseOrderSheet')
      .addSeparator()
      .addItem('실사 리스트 생성 (계열·사이즈 정렬) — ① 아침 준비 시 자동', 'buildCountSheet')
      .addItem('실사 리스트 → 재고 탭 반영', 'applyCountSheet')
      .addItem('재고 탭 자체를 실사 순서로 정렬 (1회)', 'sortStockTabLikeCount')
      .addSeparator()
      .addItem('재고 탭 빈 중분류·거래처·품목명 채우기 (품목 정보 기준)', 'fillStockTabMaster')
      .addItem('품목 정보 최신화 (이카운트 품목조회 API)', 'refreshItemMaster')
      .addSeparator()
      .addItem('재고 탭 발주 블록 갱신 (일사용량·커버일수·창고인가량)', 'upgradeStockTabLayout')
      .addItem('인가량 탭 → 재고 탭 반영 (인가량_지점명)', 'importAuthQtyToStockTab'))
    .addItem('⑦ API 연결 테스트', 'testApi')
    .addItem('⚙ API 설정', 'setupApiKeys')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('(구) 날짜탭 방식')
      .addItem('오늘 탭 생성', 'createTodayTab')
      .addItem('마감재고만 다시 받기', 'refetchClosingStock'))
    .addToUi();
}

// ══════════════════════════ ⑨ 코드매핑 (구코드 → 대표코드) ══════════════════════════
// 같은 실물 픽스쳐가 두 코드로 등록된 경우(예: PL001=ZMSN3008S(구) / PL051=ZMSN3008(신))
// [코드매핑] 탭: A구코드 B대표코드 C품목명(구) D품목명(대표) E규격키 F확인(Y/N) G비고
// 재고 탭은 대표코드 한 줄로 관리, 재고는 구+대표 합산, 전표는 구코드 재고부터 소진(선입선출)

/** 품목명/코드에서 규격 키 추출 (제조사 규격 문자열, S 접미 등 버전표기 제거) */
function specKey_(code, name) {
  var cands = [String(code || ''), String(name || '')];
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i].toUpperCase().replace('SW-', '').replace('_충남', '');
    var m = c.match(/(TS3[MS]\d{4}[A-Z]{0,2}\d?|ZM[A-Z]{2}\d{4}S?|021\.\d{4}|IF\d{4}[A-Z]*|UF\(II\)N\d{4}SF|T01\d{4}S|DSSF[MR]\d{4}|FXS\d{4}|POF\d{4}|LW[SN]F\d{4}S?)/);
    if (m) {
      var k = m[1];
      if (k.indexOf('ZM') === 0) k = k.replace(/S$/, '');   // ZMSN3008S ≈ ZMSN3008
      return k;
    }
  }
  return null;
}

/** [코드매핑] 탭 읽기 → { 구코드: 대표코드 } (확인=Y 인 행만) 와 { 대표코드: [구코드,...] } */
function loadCodeMap_(ss) {
  var toRep = {}, siblings = {};
  var sheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  if (!sheet || sheet.getLastRow() < 3) return { toRep: toRep, siblings: siblings };
  sheet.getRange(3, 1, sheet.getLastRow() - 2, 6).getValues().forEach(function (r) {
    var old = String(r[0] || '').trim(), rep = String(r[1] || '').trim(), ok = String(r[5] || '').trim().toUpperCase();
    if (!old || !rep || old === rep || ok !== 'Y') return;
    toRep[old] = rep;
    if (!siblings[rep]) siblings[rep] = [];
    siblings[rep].push(old);
  });
  return { toRep: toRep, siblings: siblings };
}

/** 코드 → 대표코드 (매핑 없으면 자기 자신) */
function repCode_(map, cd) { return map.toRep[cd] || cd; }

/**
 * [코드매핑] 탭 생성/갱신 — 품목 정보의 규격키가 같은 코드 묶음을 찾아 초안 작성.
 * 대표코드 = 이름에 S 접미가 없는 쪽(신코드), 나머지 = 구코드. 사람이 F열 확인(Y) 후 적용됨.
 * 기존 확인(Y) 행은 유지.
 */
function buildCodeMapping() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (!itemSheet) { ui.alert('[품목 정보] 탭이 없습니다.'); return; }

  // 규격키 → [{code,name,cat}]
  var groups = {};
  itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
    var code = String(r[3] || '').trim();
    if (!code) return;
    var cat = String(r[2] || '');
    if (cat !== '픽스쳐' && !/^(PL|OS|TS|SW|POF|FXS|MG|DO|PDT|LW|DTS|021)/.test(code)) return;
    var k = specKey_(code, r[4]);
    if (!k) return;
    if (!groups[k]) groups[k] = [];
    groups[k].push({ code: code, name: String(r[4] || '').trim() });
  });

  // 기존 확인된 행 보존
  var existing = {};
  var sheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  if (sheet && sheet.getLastRow() > 2) {
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 7).getValues().forEach(function (r) {
      if (r[0]) existing[String(r[0]).trim()] = r;
    });
  }

  var out = [];
  Object.keys(groups).sort().forEach(function (k) {
    var g = groups[k];
    if (g.length < 2) return;
    // 대표: 이름이 규격키와 정확히 같은 것 우선 → 그 다음 'S' 접미 없는 것 → 그 외 마지막 코드
    g.sort(function (a, b) {
      var sa = (a.name.toUpperCase() === k ? 0 : /S$/i.test(a.name) ? 2 : 1);
      var sb = (b.name.toUpperCase() === k ? 0 : /S$/i.test(b.name) ? 2 : 1);
      return sa - sb || (a.code < b.code ? -1 : 1);
    });
    var rep = g[0];
    g.slice(1).forEach(function (o) {
      var ex = existing[o.code];
      if (ex) { out.push([o.code, ex[1] || rep.code, o.name, rep.name, k, ex[5] || '', ex[6] || '']); return; }
      // 확실한 케이스는 미리 Y: 플란(PL) 코드끼리 + 품목명이 대표명+'S' (구버전 표기)만 다른 경우
      var sureS = /^PL\d/.test(o.code) && /^PL\d/.test(rep.code) && o.name.toUpperCase() === rep.name.toUpperCase() + 'S';
      // 애매한 케이스: _1/_2 접미(구매건 분리) 또는 다른 접두(지점별 구매채널 분리 가능) → 사람 확인
      var suffixed = /_\d+$/.test(o.code) || /_충남$/.test(o.code);
      var note = sureS ? '자동 확인(플란 S접미 구버전) — 아니면 F열 비우기'
               : suffixed ? '⚠ 접미 코드(구매건/지점 분리 가능) — 같은 재고로 합칠지 확인'
               : '자동 초안 — 같은 실물이면 F열에 Y';
      out.push([o.code, rep.code, o.name, rep.name, k, sureS ? 'Y' : '', note]);
    });
  });
  // 수동으로 추가했던(자동 그룹에 없는) 기존 행도 유지
  Object.keys(existing).forEach(function (old) {
    if (!out.some(function (r) { return r[0] === old; })) out.push(existing[old].slice(0, 7));
  });

  if (!sheet) sheet = ss.insertSheet(CONFIG.MAP_SHEET, (ss.getSheetByName(CONFIG.SETTINGS_SHEET) || { getIndex: function () { return 1; } }).getIndex());
  sheet.clear();
  sheet.getRange(1, 1).setValue('구코드 → 대표코드 매핑. F열에 Y를 넣은 행만 적용됨. 대표코드 한 줄로 재고 합산, 전표는 구코드 재고부터 소진. 갱신: "⑨ 코드매핑 › 매핑 초안 자동 생성"');
  sheet.getRange(2, 1, 1, 7).setValues([['구코드', '대표코드', '품목명(구)', '품목명(대표)', '규격키', '확인(Y)', '비고']]).setFontWeight('bold').setBackground('#e2f1ef');
  if (out.length) {
    sheet.getRange(3, 1, out.length, 7).setValues(out);
    sheet.getRange(3, 6, out.length, 1).setBackground('#fff9c4').setHorizontalAlignment('center');
  }
  sheet.setFrozenRows(2);
  sheet.setColumnWidths(3, 2, 200);
  ss.setActiveSheet(sheet);
  var confirmed = out.filter(function (r) { return String(r[5]).toUpperCase() === 'Y'; }).length;
  ui.alert('[코드매핑] 초안 ' + out.length + '건 (확인됨 ' + confirmed + '건)\n' +
    '· 같은 실물이 맞는 행은 F열에 Y 입력\n· 대표코드는 원하는 코드로 바꿔도 됨\n' +
    '· 확인 후 "⑨ 코드매핑 › 재고 탭에 매핑 적용" 실행');
}

/**
 * 재고 탭에서 구코드 행을 제거하고 대표코드 행만 남긴다.
 * 대표코드 행이 없으면 구코드 행을 대표코드로 개명. 비고(S열)에 "합산: 구코드…" 표기.
 */
function applyCodeMappingToStockTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var map = loadCodeMap_(ss);
  var reps = Object.keys(map.siblings);
  if (!reps.length) { ui.alert('[코드매핑] 탭에 확인(Y)된 매핑이 없습니다. "매핑 초안 자동 생성" 후 F열에 Y를 입력하세요.'); return; }

  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) return;
  var codes = main.getRange(startRow, COL.CODE, n, 1).getValues().map(function (r) { return String(r[0] || '').trim(); });
  var rowOf = {};
  codes.forEach(function (c, i) { if (c) rowOf[c] = startRow + i; });

  var toDelete = [], renamed = 0, noted = 0;
  reps.forEach(function (rep) {
    var olds = map.siblings[rep].filter(function (o) { return rowOf[o]; });
    if (!olds.length) return;
    if (!rowOf[rep]) {
      // 대표코드 행이 없음 → 첫 구코드 행을 대표코드로 개명
      var r0 = rowOf[olds[0]];
      main.getRange(r0, COL.CODE).setValue(rep);
      var repName = ss.getSheetByName(CONFIG.MAP_SHEET) ? lookupMapName_(ss, olds[0]) : '';
      if (repName) main.getRange(r0, COL.NAME).setValue(repName);
      rowOf[rep] = r0; renamed++;
      olds = olds.slice(1);
    }
    olds.forEach(function (o) { toDelete.push(rowOf[o]); });
    var note = '합산: ' + rep + '+' + map.siblings[rep].join('+');
    main.getRange(rowOf[rep], COL.MEMO).setValue(note); noted++;
  });
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { main.deleteRow(r); });

  ui.alert('✅ [' + b.name + '] 매핑 적용 완료\n· 구코드 행 삭제: ' + toDelete.length + '건\n· 대표코드로 개명: ' + renamed + '건\n· 비고에 합산 표기: ' + noted + '건\n\n' +
    '이제 ① 아침 준비를 실행하면 대표코드 행에 구+신 재고가 합산되어 들어옵니다.');
}

function lookupMapName_(ss, oldCode) {
  var sheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  if (!sheet || sheet.getLastRow() < 3) return '';
  var rows = sheet.getRange(3, 1, sheet.getLastRow() - 2, 4).getValues();
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]).trim() === oldCode) return String(rows[i][3] || '');
  return '';
}

/**
 * 전표 수량을 코드별로 분배: 구코드 재고(해당 창고)부터 소진 → 나머지 대표코드.
 * balByCode: {code: qty(해당 창고)}, 반환 [{code, qty}]
 */
function splitQtyFifo_(map, rep, qty, balByCode) {
  var out = [];
  var remain = qty;
  var olds = map.siblings[rep] || [];
  olds.forEach(function (o) {
    if (remain <= 0) return;
    var avail = Math.max(0, Number(balByCode[o] || 0));
    var take = Math.min(avail, remain);
    if (take > 0) { out.push({ code: o, qty: take }); remain -= take; }
  });
  if (remain > 0) out.push({ code: rep, qty: remain });
  return out;
}

// ══════════════════════════ ⑦ 사용안내 탭 ══════════════════════════

/** [사용안내] 탭 생성/갱신 — 매일 사용법·탭 설명·문제 대처를 시트 안에 둔다 */
function buildGuideSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = '사용안내';
  var sheet = ss.getSheetByName(name);
  if (sheet) sheet.clear();
  else sheet = ss.insertSheet(name, 0);

  var C_HEAD = '#0e6f6a', C_HEAD_TXT = '#ffffff', C_SEC = '#e2f1ef', C_STEP = '#fff9c4', C_WARN = '#fbeedb', C_LINE = '#f4f6f7';
  var rows = [];   // [A, B, C]
  var fmt = [];    // {row, kind}
  function add(a, b, c, kind) { rows.push([a || '', b || '', c || '']); fmt.push(kind || ''); }
  function sec(t) { add(t, '', '', 'sec'); }
  function gap() { add('', '', '', 'gap'); }

  add('⚡ 재고마감 자동화 — 사용안내', '', '갱신: ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'), 'title');
  add('구성', '구글시트(⚡ 재고마감 메뉴) → 중계서버(Render, 고정IP) → 이카운트 API', '이카운트가 IP를 제한해서 중계서버를 거침. 서버가 자고 있으면 최대 2분 대기 후 자동 진행', 'line');
  add('핵심 규칙', '열려 있는 재고 탭이 곧 지점', '"재고_부산점"=부산점, "재고_일산점"=일산점. 해당 탭을 연 상태에서 메뉴 실행', 'line');
  gap();

  sec('▶ 매일 사용법 (지점 담당자)');
  add('순서', '할 일', '설명', 'head');
  add('1', '⚡ 재고마감 › ① 아침 준비', '전일 마감 기준 중앙공급실 재고(F열)·창고/수술방 실재고(J·K열)를 이카운트에서 받아 채우고 입력칸을 비움', 'step');
  add('2', '중앙공급실 실사 → G열(노란칸)에 입력', '센 품목만 숫자 입력. 안 센 품목은 빈칸으로(판매 계산 제외). 환입·구매입고·페일은 L·M·N열. 판매(H)·부족수량(I)은 자동', 'step');
  add('3', '② 마감 전표 미리보기 → _전표전송 탭 검토', '판매·중앙→수술방 이동은 전일자, 창고→중앙 보충 이동은 오늘 날짜. 수량 수정 가능, 빼려면 행 삭제', 'step');
  add('4', '③ 전표 전송 → 확인창 "예"', '이카운트에 판매·창고이동 전표 생성. 전표번호는 _전표전송 K열. 같은 전표는 두 번 안 나감', 'step');
  add('5', '④ 재고 재점검', '이카운트 실재고를 다시 받아 기대재고와 대조. 차이 품목만 _재고점검 탭에 표시. 0건이면 정상', 'step');
  add('6', '⑤ 마감 저장 (퇴근 전)', '전 품목 상태를 일별기록에 저장. 담당자 실수 추적·사용량(1일)·발주수량 계산의 근거', 'step');
  gap();

  sec('▶ 재고 탭 열 안내');
  add('열', '항목', '설명', 'head');
  add('A~E', '중분류·거래처·품목코드·품목명·인가량', '인가량(E)은 지점 기준으로 직접 입력. 비어 있으면 부족수량 계산 안 됨', 'line');
  add('F', '전일재고 (자동)', '① 아침 준비 시 이카운트 전일 마감 중앙공급실 재고', 'line');
  add('G', '오늘 실사 (입력)', '중앙공급실 실사값. 판매 = F − G', 'line');
  add('H · I', '판매 · 부족수량 (수식)', '부족수량 = 인가량 − 실사 (0 미만이면 0)', 'line');
  add('J · K', '창고 실재고 · 수술방 실재고 (자동)', '참고용. 이카운트 실재고', 'line');
  add('L · M · N', '환입 · 구매입고 · 페일 (입력)', '있는 날만 입력', 'line');
  add('O~R · T', '일사용량 · 발주 커버일수 · 목표재고 · 발주수량 · 창고 인가량', '일사용량(O)=최근30일 판매÷30(자동, 초기엔 ERP 수불부 대체). 커버일수(P)=기본 4일(월·수·금 발주, 금→화 입고). 목표재고=O×P(창고 기준). 창고가용=창고실재고−오늘 중앙보충분(부족수량). 발주=MAX(목표−창고가용, 창고인가량−창고가용) 5단위 올림. 연휴 전엔 P를 늘려서 발주(다음날 자동 원복)', 'line');
  gap();

  sec('▶ 탭 설명');
  add('탭', '역할', '비고', 'head');
  add('재고_지점명 (재고_부산점 · 재고_일산점 …)', '지점 작업 탭', '매일 여기서만 작업. 복제 안 함. 지점당 1개', 'line');
  add('일별기록', '감사 로그', '⑤ 마감 저장 시 하루 한 번 전 품목 스냅샷. 일자·지점·품목으로 필터해 과거 확인', 'line');
  add('설정', '지점 설정', '지점명·판매거래처코드·담당자코드·창고 3개(드롭다운). 지점 추가는 행 추가', 'line');
  add('품목 정보', '품목 마스터', '품목명·규격·단가·분류 참조', 'line');
  add('_전표전송 / _재고점검', '작업 결과', '②③④ 실행 결과. 매번 덮어씀', 'line');
  add('_창고목록 / _API디버그', '숨김', '창고 드롭다운 소스 / API 원본 응답(오류 원인 확인용, 최근 30건)', 'line');
  gap();

  sec('▶ 지점 추가');
  add('1', '⑧ 지점 관리 › 설정 탭 생성/열기', '행 추가 후 지점명·판매거래처코드(이카운트 거래처코드)·담당자코드 입력', 'step');
  add('2', '⑧ 지점 관리 › 창고 목록 새로고침', '이카운트 창고 전체를 받아 D~F열 드롭다운 갱신', 'step');
  add('3', '설정 탭에서 수술방·중앙공급실·보관창고 선택', '드롭다운에서 선택 (창고명이 이카운트와 정확히 같아야 함)', 'step');
  add('4', '⑧ 지점 관리 › 지점 재고탭 생성', '지점명 입력 → 지점 창고에 재고 있는 품목으로 재고_지점명 탭 자동 생성. 이후 인가량(E) 입력', 'step');
  gap();

  sec('▶ 코드매핑 (같은 픽스쳐가 구코드·신코드 두 개로 등록된 경우)');
  add('규칙', '대표코드 한 줄로 관리, 재고는 구+신 합산', '예: PL051(ZMSN3008)이 대표, PL001(ZMSN3008S)은 구코드. 재고 탭에는 PL051 한 줄, 비고에 "합산: PL051+PL001"', 'line');
  add('전표', '구코드 재고부터 소진 → 나머지 대표코드', '판매·이동 전표가 코드별로 자동 분할됨 (미리보기 품목명 뒤 [코드]로 표시). 구코드 재고가 0이 되면 자연히 신코드만 남음', 'line');
  add('설정', '⑨ 코드매핑 › 매핑 초안 자동 생성', '품목명 규격이 같은 코드를 찾아 [코드매핑] 탭에 초안. F열에 Y를 넣은 행만 적용. 대표코드는 바꿔도 됨', 'line');
  add('적용', '⑨ 코드매핑 › 재고 탭에 매핑 적용', '해당 지점 재고 탭에서 구코드 행 삭제·대표코드 행만 남김 (지점 탭마다 1회). 이후 ① 아침 준비부터 합산 반영', 'line');
  add('추가', '새 구코드 발견 시', '[코드매핑] 탭에 행 추가(구코드·대표코드·Y) 후 "재고 탭에 매핑 적용" 재실행', 'line');
  gap();

  sec('▶ 문제가 생기면');
  add('증상', '원인 · 조치', '', 'head');
  add('"허용되지 않은 IP [xx.xx.xx.xx]"', '중계서버 IP가 바뀜. 메시지의 IP를 이카운트 ERP › API인증키발급 › IP등록에 추가', '', 'warn');
  add('"중계 서버가 응답하지 않습니다"', '서버 기동 지연. 1~2분 후 재실행. 계속되면 Render 대시보드 확인', '', 'warn');
  add('"지점 재고 탭을 연 상태에서 실행하세요"', '다른 탭에서 메뉴 실행함. 재고_지점명 탭(예: 재고_부산점)으로 이동 후 재실행', '', 'warn');
  add('"창고코드를 찾지 못한 행"', '⑧ 지점 관리 › 창고 목록 새로고침 실행 후 재시도', '', 'warn');
  add('전표 상태 "오류: …"', '_API디버그 시트(숨김) 맨 윗줄에 이카운트 원본 응답. 담당자/거래처/창고 미등록코드 확인', '', 'warn');
  add('④ 재점검에서 차이 발생', '전표 미전송(상태 "대기") → 수량 수정 후 시트 미반영 → 타 창고 이동 순으로 확인', '', 'warn');
  gap();

  sec('▶ 링크');
  add('스크립트', 'script.google.com › 재고마감 자동화 프로젝트', '', 'line');
  add('서버 코드·스크립트 백업', 'github.com/Leechangkwon/ecount-relay', 'apps-script/daily-closing.gs', 'line');
  add('서버 관리', 'dashboard.render.com › ecount-relay', '', 'line');

  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 380);
  sheet.setColumnWidth(3, 520);
  sheet.getRange(1, 1, rows.length, 3).setWrap(true).setVerticalAlignment('top').setFontSize(10);

  fmt.forEach(function (kind, i) {
    var r = i + 1;
    var rng = sheet.getRange(r, 1, 1, 3);
    if (kind === 'title') { rng.setFontSize(14).setFontWeight('bold'); sheet.getRange(r, 3).setFontSize(9).setFontColor('#7c8a94').setFontWeight('normal'); }
    else if (kind === 'sec') { rng.setBackground(C_HEAD).setFontColor(C_HEAD_TXT).setFontWeight('bold').setFontSize(11); sheet.getRange(r, 1, 1, 3).mergeAcross(); }
    else if (kind === 'head') { rng.setBackground(C_SEC).setFontWeight('bold').setFontColor('#0e6f6a'); }
    else if (kind === 'step') { sheet.getRange(r, 1).setBackground(C_STEP).setFontWeight('bold').setHorizontalAlignment('center'); sheet.getRange(r, 2).setFontWeight('bold'); }
    else if (kind === 'warn') { sheet.getRange(r, 1).setBackground(C_WARN).setFontWeight('bold'); }
    else if (kind === 'line') { sheet.getRange(r, 1).setFontWeight('bold').setFontColor('#4a5963'); }
  });
  sheet.setFrozenRows(1);
  sheet.setHiddenGridlines(true);
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(1);
  SpreadsheetApp.getUi().alert('[사용안내] 탭을 갱신했습니다. (탭 맨 앞에 배치)');
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
    sheet.getRange(3, 1, 3, 7).setValues([
      ['부산점', '부산점', CONFIG.EMP_CD, CONFIG.DEFAULT_BRANCH.whSurgery, CONFIG.DEFAULT_BRANCH.whCentral, CONFIG.DEFAULT_BRANCH.whStorage, CONFIG.DEFAULT_COVER_DAYS],
      ['일산점', '일산점', CONFIG.EMP_CD, '플란치과_일산점_수술방', '플란치과_일산점_중앙공급실(구매팀)', '플란치과_일산점_구매팀 창고', CONFIG.DEFAULT_COVER_DAYS],
      ['부평점', '부평점', CONFIG.EMP_CD, '', '', '', CONFIG.DEFAULT_COVER_DAYS]
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
  sheet.getRange(2, 1, names.length, 1).setNumberFormat('@'); // 창고코드 '00011' 앞 0 보존
  sheet.getRange(2, 1, names.length, 2).setValues(names.map(function (n) { return [String(wh[n]), n]; }));
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
/** 이카운트 창고코드는 5자리 문자열(예: '00011'). 숫자로 저장돼 0이 사라진 경우 복원 */
function whCode5_(v) {
  var s = String(v == null ? '' : v).trim();
  if (/^\d{1,4}$/.test(s)) s = ('00000' + s).slice(-5);
  return s;
}

function loadWhMap_(ss) {
  var map = {};
  Object.keys(CONFIG.WH_CODES).forEach(function (k) { map[k] = CONFIG.WH_CODES[k]; });
  var sheet = ss.getSheetByName(CONFIG.WHLIST_SHEET);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0] !== '' && r[0] != null && r[1]) map[String(r[1]).trim()] = whCode5_(r[0]);
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
    // G열(발주커버일수)이 없는 구버전 설정 탭이면 헤더 추가
    if (String(sheet.getRange(2, 7).getValue()) !== '발주커버일수') {
      sheet.getRange(2, 7).setValue('발주커버일수').setFontWeight('bold');
    }
    sheet.getRange(3, 1, sheet.getLastRow() - 2, 7).getValues().forEach(function (r) {
      var name = String(r[0] || '').trim();
      if (!name) return;
      out[name] = {
        name: name, cust: String(r[1] || name).trim(), emp: String(r[2] || CONFIG.EMP_CD).trim(),
        whSurgery: String(r[3] || '').trim(), whCentral: String(r[4] || '').trim(), whStorage: String(r[5] || '').trim(),
        coverDays: Number(r[6]) > 0 ? Number(r[6]) : CONFIG.DEFAULT_COVER_DAYS
      };
    });
  }
  out[d.name].coverDays = out[d.name].coverDays || CONFIG.DEFAULT_COVER_DAYS;
  return out;
}

/** 현재 활성 시트에서 지점 판별: 탭 이름 '재고_지점명' */
function branchFromActive_(ss) {
  var name = ss.getActiveSheet().getName();
  var branchName = null;
  if (name.indexOf('재고_') === 0) branchName = name.slice(3);
  else if (name === CONFIG.MAIN_SHEET) {
    // (구) 이름 '재고' 탭이 남아 있으면 자동으로 '재고_부산점'으로 바꿔서 계속 진행
    ss.getActiveSheet().setName('재고_' + CONFIG.DEFAULT_BRANCH.name);
    branchName = CONFIG.DEFAULT_BRANCH.name;
  }
  if (!branchName) {
    throw new Error('지점 재고 탭([재고_지점명], 예: 재고_부산점)을 연 상태에서 실행하세요.\n(현재 탭: ' + name + ')');
  }
  var b = getBranches_(ss)[branchName];
  if (!b) throw new Error('[설정] 탭에 "' + branchName + '" 지점이 없습니다. "⑧ 지점 관리 > 설정 탭"에서 추가하세요.');
  if (!b.whSurgery || !b.whCentral || !b.whStorage) {
    throw new Error('"' + branchName + '" 지점의 창고가 [설정] 탭에서 선택되지 않았습니다. (수술방/중앙공급실/보관창고)');
  }
  b.sheet = ss.getActiveSheet();
  return b;
}

/** (구) '재고' 탭을 '재고_부산점'으로 개명하고 재고_ 탭들을 앞쪽에 모아 정렬 */
function renameLegacyStockTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var legacy = ss.getSheetByName(CONFIG.MAIN_SHEET);
  var target = '재고_' + CONFIG.DEFAULT_BRANCH.name;
  var msg = [];
  if (legacy) {
    if (ss.getSheetByName(target)) { ui.alert('"' + target + '" 탭이 이미 있어 "' + CONFIG.MAIN_SHEET + '" 탭을 개명할 수 없습니다. 둘 중 하나를 정리하세요.'); return; }
    legacy.setName(target);
    msg.push('"' + CONFIG.MAIN_SHEET + '" → "' + target + '" 개명');
  }
  // 재고_ 탭을 [설정] 탭 바로 뒤에 순서대로 모음 (부산점 먼저)
  var stockTabs = ss.getSheets().filter(function (s) { return s.getName().indexOf('재고_') === 0; });
  stockTabs.sort(function (a, b) {
    var an = a.getName(), bn = b.getName();
    if (an === target) return -1;
    if (bn === target) return 1;
    return an < bn ? -1 : 1;
  });
  var anchor = ss.getSheetByName(CONFIG.SETTINGS_SHEET) || ss.getSheetByName('사용안내');
  var pos = anchor ? anchor.getIndex() + 1 : 1;
  stockTabs.forEach(function (s) {
    ss.setActiveSheet(s);
    ss.moveActiveSheet(pos);
    pos++;
  });
  msg.push('재고 탭 ' + stockTabs.length + '개 정렬: ' + stockTabs.map(function (s) { return s.getName(); }).join(', '));
  ss.setActiveSheet(ss.getSheetByName(target) || stockTabs[0]);
  ui.alert('✅ ' + msg.join('\n'));
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
  var map = loadCodeMap_(ss);
  var codes = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['PROD_CD']) || '').trim();
    var wh = normalize_(String(firstOf_(r, ['WH_DES']) || ''));
    if (cd && whSet[wh] && Number(firstOf_(r, ['BAL_QTY']) || 0)) {
      var rep = repCode_(map, cd);   // 구코드는 대표코드 한 줄로
      if (!codes[rep]) codes[rep] = (rep === cd ? firstOf_(r, ['PROD_DES']) : lookupMapName_(ss, cd)) || firstOf_(r, ['PROD_DES']) || '';
    }
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

/** 재고탭 공통 틀 생성 (헤더/수식/서식) — data: 19~20열 배열. 기존 재고_ 탭들 바로 뒤에 배치 */
function buildStockTabFrame_(ss, tabName, data) {
  var pos = 1;
  ss.getSheets().forEach(function (s, i) { if (s.getName().indexOf('재고_') === 0) pos = i + 1; });
  var main = ss.insertSheet(tabName, pos);
  writeStockHeaders_(main);
  var n = data.length;
  var startRow = CONFIG.DATA_START_ROW;
  var padded = data.map(function (r) { var x = r.slice(0, 20); while (x.length < 20) x.push(''); return x; });
  main.getRange(startRow, 1, n, 20).setValues(padded);
  writeStockFormulas_(main, startRow, n);
  return main;
}

/** 재고탭 1~2행 헤더 (기존 탭 갱신에도 사용) */
function writeStockHeaders_(main) {
  main.getRange(1, 1, 2, 20).clearContent();
  main.getRange(1, COL.PREV, 1, 4).setValues([['중앙공급실 (매일 실사)', '', '', '']]);
  main.getRange(1, COL.STORAGE, 1, 2).setValues([['실재고(자동)', '']]);
  main.getRange(1, COL.USAGE, 1, 4).setValues([['발주 (사용량 기반)', '', '', '']]);
  main.getRange(2, 1, 1, 20).setValues([[
    '중분류', '거래처', '품목코드', '품목명', '공급실 인가량',
    '전일재고\n(자동)', '오늘 실사\n입력칸', '판매\n(수식)', '부족수량\n(수식)',
    '창고 실재고\n(자동)', '수술방 실재고\n(자동)',
    '환입\n입력칸', '구매입고\n입력칸', '페일\n입력칸',
    '일사용량\n(자동·최근30일)', '발주 커버일수\n입력칸(기본4)', '목표재고\n(수식)', '발주수량\n(수식)', '비고', '창고 인가량\n(발주 하한)'
  ]]);
  main.getRange(1, 1, 2, 20).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  main.setFrozenRows(2);
  main.setFrozenColumns(4);
}

/** 재고탭 수식/서식 (기존 탭 갱신에도 사용) */
function writeStockFormulas_(main, startRow, n) {
  var U = CONFIG.ORDER_ROUND_UNIT;
  var fSale = [], fNeed = [], fReq = [], fOrder = [];
  for (var i = 0; i < n; i++) {
    var r = startRow + i;
    fSale.push(['=IF($G' + r + '="","",$F' + r + '-$G' + r + ')']);
    fNeed.push(['=IF($G' + r + '="","",MAX(0,N($E' + r + ')-$G' + r + '))']);
    // 목표재고 = 일사용량 × 커버일수 (창고 기준)
    fReq.push(['=IF(OR($O' + r + '="",$P' + r + '=""),"",$O' + r + '*$P' + r + ')']);
    // 창고 가용재고 = 창고실재고 − 오늘 중앙 보충분(부족수량 I; 실사 전이면 인가량E − 전일중앙F)
    // 발주 = MAX( 목표재고 − 창고가용, 창고인가량 − 창고가용 ) 를 발주단위로 올림. 목표·인가량 둘 다 없으면 빈칸
    var avail = '(N($J' + r + ')-IF($I' + r + '<>"",N($I' + r + '),MAX(0,N($E' + r + ')-N($F' + r + '))))';
    fOrder.push(['=IF(AND($Q' + r + '="",$T' + r + '=""),"",MAX(0,CEILING(MAX(N($Q' + r + ')-' + avail + ',N($T' + r + ')-' + avail + ')/' + U + ',1)*' + U + '))']);
  }
  main.getRange(startRow, COL.SALE, n, 1).setFormulas(fSale);
  main.getRange(startRow, COL.NEED, n, 1).setFormulas(fNeed);
  main.getRange(startRow, COL.REQ, n, 1).setFormulas(fReq);
  main.getRange(startRow, COL.ORDER, n, 1).setFormulas(fOrder);

  var yellow = '#fff9c4', gray = '#f0f0f0', blue = '#e3f2fd';
  [COL.COUNT, COL.RET, COL.PURCHASE, COL.FAIL, COL.DAYS, COL.WH_ALLOW].forEach(function (c) {
    main.getRange(startRow, c, n, 1).setBackground(yellow);
  });
  [COL.PREV, COL.STORAGE, COL.SURGERY, COL.USAGE].forEach(function (c) {
    main.getRange(startRow, c, n, 1).setBackground(gray);
  });
  main.getRange(startRow, COL.ORDER, n, 1).setBackground(blue).setFontWeight('bold');
}

/**
 * [인가량_지점명] 탭 (A품목코드 B품목명 C창고인가량 D공급실인가량) → 활성 지점 재고탭의 E(공급실 인가량)·T(창고 인가량)에 반영.
 * 코드매핑이 있으면 구코드 인가량은 대표코드에 합산. 재고탭에 없는 코드는 결과 팝업에 표시.
 */
function importAuthQtyToStockTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var src = ss.getSheetByName('인가량_' + b.name);
  if (!src) {
    // 탭이 없으면 별도 스프레드시트 ID/URL 입력받아 복사해 옴
    var res = ui.prompt('[인가량_' + b.name + '] 탭이 없습니다.\n인가량 스프레드시트의 URL 또는 ID를 입력하면 첫 시트를 [인가량_' + b.name + '] 탭으로 복사합니다.\n(열: A품목코드 B품목명 C창고인가량 D공급실인가량, 1행 헤더)', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    var idm = res.getResponseText().trim().match(/[-\w]{25,}/);
    if (!idm) { ui.alert('스프레드시트 ID를 해석할 수 없습니다.'); return; }
    var ext = SpreadsheetApp.openById(idm[0]).getSheets()[0];
    src = ext.copyTo(ss).setName('인가량_' + b.name);
    src.hideSheet();
  }
  var map = loadCodeMap_(ss);
  var wh = {}, cen = {};
  src.getDataRange().getValues().slice(1).forEach(function (r) {
    var cd = String(r[0] || '').trim();
    if (!cd) return;
    var rep = repCode_(map, cd);
    if (r[2] !== '' && r[2] != null && !isNaN(Number(r[2]))) wh[rep] = (wh[rep] || 0) + Number(r[2]);
    if (r[3] !== '' && r[3] != null && !isNaN(Number(r[3]))) cen[rep] = (cen[rep] || 0) + Number(r[3]);
  });
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  var codes = main.getRange(startRow, COL.CODE, n, 1).getValues().map(function (r) { return String(r[0] || '').trim(); });
  var eVals = main.getRange(startRow, COL.ALLOW, n, 1).getValues();
  var tVals = main.getRange(startRow, COL.WH_ALLOW, n, 1).getValues();
  var hitE = 0, hitT = 0, seen = {};
  codes.forEach(function (cd, i) {
    if (!cd) return;
    seen[cd] = true;
    if (cen[cd] != null) { eVals[i][0] = cen[cd]; hitE++; }
    if (wh[cd] != null) { tVals[i][0] = wh[cd]; hitT++; }
  });
  main.getRange(startRow, COL.ALLOW, n, 1).setValues(eVals);
  main.getRange(startRow, COL.WH_ALLOW, n, 1).setValues(tVals);
  var missing = Object.keys(cen).concat(Object.keys(wh)).filter(function (c, i, a) { return a.indexOf(c) === i && !seen[c]; });
  ui.alert('✅ [' + b.name + '] 인가량 반영\n· 공급실 인가량(E): ' + hitE + '건\n· 창고 인가량(T): ' + hitT + '건' +
    (missing.length ? '\n\n⚠ 재고 탭에 없는 코드 ' + missing.length + '건 (재고 0이라 시드에서 빠진 품목 — 필요하면 재고 탭에 행 추가):\n' + missing.slice(0, 15).join(', ') + (missing.length > 15 ? ' …' : '') : ''));
}

// ══════════════════════════ ⑩ 품목 정보 최신화 (이카운트 품목조회 API) ══════════════════════════

/** 중계서버 읽기 전용 조회 */
function ecountQuery_(kind, payload, pathOverride) {
  var relay = getRelayProps_();
  wakeRelay_(relay);
  var url = relay.url + '/api/ecount/query';
  var body = { kind: kind, payload: payload || {} };
  if (pathOverride) body.path = pathOverride;
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Relay-Token': relay.token },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  logDebug_(url + ' [' + (kind || pathOverride) + ']', body, code, text);
  var json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('HTTP ' + code + ' — 응답 해석 실패'); }
  if (code !== 200 || !json.ok) throw new Error((json && json.msg) || ('HTTP ' + code));
  return json.data;
}

/**
 * 이카운트 품목조회로 [품목 정보] 탭 갱신 — 기존 행은 유지·갱신, 새 코드는 추가.
 * 품목 정보 열: A구매처명 B대분류 C중분류 D품목코드 E품목명 F규격 G단위 H입고단가 (I~ 기타)
 * 응답 필드는 회사 설정에 따라 다르므로 여러 후보명을 순서대로 시도한다.
 */
function refreshItemMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (!sheet) { ui.alert('[품목 정보] 탭이 없습니다.'); return; }

  var data;
  try { data = ecountQuery_('products', {}); }
  catch (e) { ui.alert('품목조회 실패: ' + e.message + '\n"_API디버그" 시트에서 원본 응답을 확인하세요.'); return; }
  var rows = (data && (data.Result || data.Results || (data.Datas && data.Datas.Result))) || [];
  if (!rows.length) { ui.alert('품목조회 응답에 데이터가 없습니다. "_API디버그" 시트를 확인하세요.\n응답 키: ' + Object.keys(data || {}).join(', ')); return; }

  // 품목조회 응답(확인됨): PROD_CD, PROD_DES, SIZE_DES, UNIT, IN_PRICE, CUST(거래처코드), CLASS_CD(대분류코드), CLASS_CD2(중분류코드)
  // 코드→이름은 응답에 없으므로 기존 [품목 정보]에서 학습 (같은 코드를 가진 기존 품목의 이름 중 최빈값)
  var last = sheet.getLastRow();
  var existing = last > 1 ? sheet.getRange(2, 1, last - 1, 8).getValues() : [];
  var apiByCode = {};
  rows.forEach(function (r) { var cd = String(r.PROD_CD || '').trim(); if (cd) apiByCode[cd] = r; });
  var custName = {}, cls1Name = {}, cls2Name = {};
  function learn(map, key, val) { if (!key || !val) return; if (!map[key]) map[key] = {}; map[key][val] = (map[key][val] || 0) + 1; }
  function best(map, key) { var m = map[key]; if (!m) return ''; var b = '', n = 0; Object.keys(m).forEach(function (k) { if (m[k] > n) { n = m[k]; b = k; } }); return b; }
  existing.forEach(function (r) {
    var cd = String(r[3] || '').trim(); var a = apiByCode[cd]; if (!a) return;
    learn(custName, String(a.CUST || ''), String(r[0] || '').trim());
    learn(cls1Name, String(a.CLASS_CD || ''), String(r[1] || '').trim());
    learn(cls2Name, String(a.CLASS_CD2 || ''), String(r[2] || '').trim());
  });

  var byCode = {};
  rows.forEach(function (r) {
    var cd = String(r.PROD_CD || '').trim();
    if (!cd) return;
    byCode[cd] = {
      vendor: best(custName, String(r.CUST || '')) || (r.CUST ? '(거래처코드 ' + r.CUST + ')' : ''),
      cat1: best(cls1Name, String(r.CLASS_CD || '')),
      cat2: best(cls2Name, String(r.CLASS_CD2 || '')),
      name: String(r.PROD_DES || ''),
      size: String(r.SIZE_DES || ''),
      unit: String(r.UNIT || ''),
      price: Number(r.IN_PRICE) || ''
    };
  });

  var seen = {}, updated = 0;
  existing.forEach(function (r, i) {
    var cd = String(r[3] || '').trim();
    if (!cd) return;
    seen[cd] = true;
    var it = byCode[cd];
    if (!it) return;
    var changed = false;
    // 빈 칸만 채움 (사람이 정리한 값은 보존). 단가는 API 값으로 갱신
    if (!String(r[0] || '').trim() && it.vendor) { r[0] = it.vendor; changed = true; }
    if (!String(r[1] || '').trim() && it.cat1) { r[1] = it.cat1; changed = true; }
    if (!String(r[2] || '').trim() && it.cat2) { r[2] = it.cat2; changed = true; }
    if (!String(r[4] || '').trim() && it.name) { r[4] = it.name; changed = true; }
    if (!String(r[5] || '').trim() && it.size) { r[5] = it.size; changed = true; }
    if (!String(r[6] || '').trim() && it.unit) { r[6] = it.unit; changed = true; }
    if (it.price !== '' && Number(r[7]) !== it.price) { r[7] = it.price; changed = true; }
    if (changed) updated++;
  });
  if (existing.length) sheet.getRange(2, 1, existing.length, 8).setValues(existing);

  var added = [];
  Object.keys(byCode).sort().forEach(function (cd) {
    if (seen[cd]) return;
    var it = byCode[cd];
    added.push([it.vendor, it.cat1, it.cat2, cd, it.name, it.size, it.unit, it.price]);
  });
  if (added.length) sheet.getRange(sheet.getLastRow() + 1, 1, added.length, 8).setValues(added);

  ui.alert('✅ 품목 정보 최신화 — API 품목 ' + Object.keys(byCode).length + '건' + (rows.length >= 10000 ? ' (⚠ 1만 건 상한 — 일부 누락 가능)' : '') + '\n· 기존 행 갱신 ' + updated + '건\n· 신규 추가 ' + added.length + '건' +
    (added.length ? '\n\n신규 예: ' + added.slice(0, 8).map(function (a) { return a[3]; }).join(', ') : '') +
    '\n\n이어서 재고 탭에서 "빈 중분류·거래처·품목명 채우기"를 실행하세요.');
}

// ══════════════════════════ ⑩ 재고 탭 마스터 보강 ══════════════════════════

/**
 * 활성 지점 재고 탭의 빈 중분류(A)·거래처(B)·품목명(D)을 [품목 정보]에서 채운다.
 * 코드매핑된 대표코드는 자기 코드 → 구코드 순으로 품목 정보를 찾는다. 기존 값은 덮어쓰지 않음.
 */
function fillStockTabMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (!itemSheet) { ui.alert('[품목 정보] 탭이 없습니다.'); return; }
  var info = {};
  itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
    var cd = String(r[3] || '').trim();
    if (cd) info[cd] = { vendor: String(r[0] || '').trim(), cat: String(r[2] || '').trim(), name: String(r[4] || '').trim() };
  });
  var map = loadCodeMap_(ss);
  function lookup(code) {
    if (info[code]) return info[code];
    var olds = map.siblings[code] || [];
    for (var i = 0; i < olds.length; i++) if (info[olds[i]]) return info[olds[i]];
    return null;
  }
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) return;
  var rng = main.getRange(startRow, 1, n, 4);
  var vals = rng.getValues();
  var fCat = 0, fVen = 0, fName = 0, miss = [];
  vals.forEach(function (r) {
    var code = String(r[2] || '').trim();
    if (!code) return;
    var it = lookup(code);
    if (!it) { miss.push(code); return; }
    if (!String(r[0] || '').trim() && it.cat) { r[0] = it.cat; fCat++; }
    if (!String(r[1] || '').trim() && it.vendor) { r[1] = it.vendor; fVen++; }
    if (!String(r[3] || '').trim() && it.name) { r[3] = it.name; fName++; }
  });
  rng.setValues(vals);
  ui.alert('✅ [' + b.name + '] 채움 — 중분류 ' + fCat + '건, 거래처 ' + fVen + '건, 품목명 ' + fName + '건' +
    (miss.length ? '\n⚠ 품목 정보에 없는 코드 ' + miss.length + '건: ' + miss.slice(0, 12).join(', ') + (miss.length > 12 ? ' …' : '') : ''));
}

// ══════════════════════════ ⑩ 실사 리스트 (계열·사이즈 정렬) ══════════════════════════

/**
 * 품목명/규격에서 정렬키 추출: { series(계열문자), dia(직경), len(길이) }
 *  ZMTR4011 → ZMTR / 4.0 / 11     TS3S4508BV5 → TS3S / 4.5 / 8     ST4507C → ST / 4.5 / 7
 *  STHA405R → STHA / 4 / 5 (직경1+높이2)   BLT Ø4.1mm RC, SLA® 8mm → BLT / 4.1 / 8
 *  IF5507DC → IF / 5.5 / 7    021.5508 → 021 / 5.5 / 8 (앞 2자리 직경코드)
 */
function sizeKey_(name, size) {
  var s = String(name || '').trim();
  var m;
  // 1) 스트라우만식: Ø4.1mm ... 8mm / Ø4.1 / 8mm
  m = s.match(/Ø\s*(\d+(?:\.\d+)?)\s*mm?[^0-9]*?(\d+(?:\.\d+)?)\s*mm/i) || String(size || '').match(/Ø\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (m) return { series: (s.match(/^[A-Za-z]+/) || [''])[0].toUpperCase(), dia: Number(m[1]), len: Number(m[2]) };
  // 2) 계열문자 + 4자리 숫자 (직경2 + 길이2) + 표면/버전 접미  예: ZMTR4011, TS3S4508BV5, ST4507C, ZESTR4007C1, MIIP3512HT, IF5507DC
  m = s.match(/^([A-Za-z]+(?:\d[A-Za-z]+)?)[- ]?(\d{2})(\d{2})([A-Za-z]*)/);
  if (m) {
    var series = m[1].toUpperCase();
    // 오스템 TS3M/TS3S: 사이즈 뒤 A=SOI, B=BA, C=CA 표면 구분 → 계열에 붙여 따로 묶음 (V2/V4/V5 버전은 무시)
    if (/^TS3[MS]$/.test(series)) {
      var surf = (m[4] || '').toUpperCase().charAt(0);
      var surfName = { A: 'SOI', B: 'BA', C: 'CA' }[surf];
      if (surfName) series = series + '-' + surfName;
    }
    return { series: series, dia: Number(m[2]) / 10, len: Number(m[3]) };
  }
  // 3) 계열문자 + 3자리 (직경1 + 높이2)  예: STHA405R, AROHAN 309, AROCSR 3705(4자리→규칙2)
  m = s.match(/^([A-Za-z]+(?:\s*-\s*[A-Za-z]+)?)\s*(\d)(\d{2})(?![\d])/);
  if (m) return { series: m[1].replace(/\s+/g, '').toUpperCase(), dia: Number(m[2]), len: Number(m[3]) };
  // 4) 코드형 021.5508 (스트라우만 SLA)
  m = s.match(/^0?(\d{2})\.(\d{2})(\d{2})/) ;
  if (m) return { series: '021', dia: Number(m[2]) / 10, len: Number(m[3]) };
  return { series: (s.match(/^[A-Za-z가-힣]+/) || [s.slice(0, 4)])[0].toUpperCase(), dia: 999, len: 999 };
}

/** 실사 리스트 생성 (메뉴): 활성 지점 재고 탭 → [_실사리스트] (중분류 → 계열 → 직경 → 길이 → 코드 순) */
function buildCountSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var n = buildCountSheet_(ss, b, false);
  ui.alert('✅ [' + b.name + '] 실사 리스트 ' + n + '품목 생성 (중분류 → 계열 → Ø → L 순)\n' +
    'I열에 실사값 입력 후 "⑩ 실사 리스트 → 재고 탭 반영"을 누르면 재고 탭 G열로 옮겨집니다.');
}

/** 재고 탭 자체를 실사 순서(중분류→계열→Ø→L)로 정렬 — 1회 실행, 데이터·수식 유지 */
function sortStockTabLikeCount() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) return;
  var sizeInfo = {}, catInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[3]) { var cd = String(r[3]).trim(); sizeInfo[cd] = String(r[5] || ''); catInfo[cd] = String(r[2] || ''); }
  });
  var rng = main.getRange(startRow, 1, n, 20);
  var vals = rng.getValues();
  var keyed = vals.map(function (r, i) {
    var code = String(r[COL.CODE - 1] || '').trim();
    var k = sizeKey_(String(r[COL.NAME - 1] || ''), sizeInfo[code]);
    return { r: r, i: i, cat: String(r[COL.CAT - 1] || '').trim() || catInfo[code] || '기타', series: k.series, dia: k.dia, len: k.len, code: code };
  });
  keyed.sort(countCompare_);
  // 수식 열은 다시 써야 하므로 값만 정렬 후 수식 재적용
  rng.setValues(keyed.map(function (x) { return x.r; }));
  writeStockFormulas_(main, startRow, n);
  ui.alert('✅ [' + b.name + '] 재고 탭을 실사 순서로 정렬했습니다 (' + n + '품목). 이제 재고 탭에서 바로 순서대로 실사 입력 가능.');
}

var COUNT_CAT_ORDER = ['픽스쳐', '힐링', '커버스크류', '코핑', 'MUA', '스캔바디', '랩아날로그', '뼈이식재', '멤브레인', '페일픽스쳐'];
function countCompare_(a, c) {
  var ca = COUNT_CAT_ORDER.indexOf(a.cat), cc = COUNT_CAT_ORDER.indexOf(c.cat);
  if (ca < 0) ca = 99; if (cc < 0) cc = 99;
  if (ca !== cc) return ca - cc;
  if (a.cat !== c.cat) return a.cat < c.cat ? -1 : 1;
  if (a.series !== c.series) return a.series < c.series ? -1 : 1;
  if (a.dia !== c.dia) return a.dia - c.dia;
  if (a.len !== c.len) return a.len - c.len;
  return a.code < c.code ? -1 : 1;
}

/** 실사 리스트 생성 (내부). quiet=true면 활성 시트를 바꾸지 않음. 반환: 품목 수 */
function buildCountSheet_(ss, b, quiet) {
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) throw new Error('품목이 없습니다.');
  var data = main.getRange(startRow, 1, n, 20).getValues();

  var sizeInfo = {}, catInfo = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[3]) { var cd = String(r[3]).trim(); sizeInfo[cd] = String(r[5] || ''); catInfo[cd] = String(r[2] || ''); }
  });

  var items = [];
  data.forEach(function (r, i) {
    var code = String(r[COL.CODE - 1] || '').trim();
    if (!code) return;
    var name = String(r[COL.NAME - 1] || '');
    var k = sizeKey_(name, sizeInfo[code]);
    items.push({
      cat: String(r[COL.CAT - 1] || '').trim() || catInfo[code] || '기타', series: k.series, dia: k.dia, len: k.len, code: code, name: name,
      size: sizeInfo[code] || '', prev: r[COL.PREV - 1], count: r[COL.COUNT - 1], storage: r[COL.STORAGE - 1], surgery: r[COL.SURGERY - 1],
      srcRow: startRow + i
    });
  });
  items.sort(countCompare_);

  // 출력 구성: 중분류 밴드(진한) → 계열 밴드(연한) → 품목 행. 밴드 행은 원본행(L) 비움
  var out = [], catBands = [], seriesBands = [], itemRows = [];
  var lastCat = null, lastSeries = null;
  items.forEach(function (it) {
    if (it.cat !== lastCat) {
      out.push(['▶ ' + it.cat, '', '', '', '', '', '', '', '', '', '', '']);
      catBands.push(out.length); lastCat = it.cat; lastSeries = null;
    }
    if (it.series !== lastSeries) {
      out.push(['', it.series, '', '', '', '', '', '', '', '', '', '']);
      seriesBands.push(out.length); lastSeries = it.series;
    }
    out.push([it.cat, it.series, it.dia < 999 ? it.dia : '', it.len < 999 ? it.len : '', it.code, it.name, it.size,
      it.prev, it.count === '' ? '' : it.count, it.storage, it.surgery, it.srcRow]);
    itemRows.push(out.length);
  });

  var sheet = ss.getSheetByName(CONFIG.COUNT_SHEET);
  if (sheet) { sheet.clear(); sheet.clearFormats(); if (sheet.getMaxColumns() >= 12) sheet.showColumns(12); }
  else sheet = ss.insertSheet(CONFIG.COUNT_SHEET, ss.getSheets().length);
  var HEAD = 2, START = 3, COLS = 12;
  sheet.getRange(1, 1).setValue('[' + b.name + '] 중앙공급실 실사 리스트 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'M/d (E)') +
    ' — 실사값은 I열(노란칸)에 입력 후 "⑩ 실사 리스트 → 재고 탭 반영"');
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(12).setFontColor('#0e6f6a');
  sheet.getRange(HEAD, 1, 1, COLS).setValues([['중분류', '계열', 'Ø', 'L', '품목코드', '품목명', '규격', '전일 중앙', '실사 입력', '창고', '수술방', '원본행']])
    .setFontWeight('bold').setBackground('#0e6f6a').setFontColor('#ffffff').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(HEAD, 28);
  sheet.getRange(START, 1, out.length, COLS).setValues(out).setFontSize(10).setVerticalAlignment('middle');
  sheet.setFrozenRows(HEAD);

  // 열 너비·정렬
  [[1, 70], [2, 90], [3, 40], [4, 40], [5, 95], [6, 250], [7, 150], [8, 70], [9, 80], [10, 60], [11, 60]].forEach(function (cw) { sheet.setColumnWidth(cw[0], cw[1]); });
  sheet.getRange(START, 3, out.length, 2).setHorizontalAlignment('center');
  sheet.getRange(START, 8, out.length, 4).setHorizontalAlignment('center');
  sheet.getRange(START, 1, out.length, 1).setFontColor('#9aa5ad').setFontSize(9); // 품목행의 중분류는 흐리게(밴드가 대신 표시)

  // 밴드 서식
  catBands.forEach(function (r) {
    var rng = sheet.getRange(START + r - 1, 1, 1, COLS - 1);
    rng.merge().setBackground('#1f4e5f').setFontColor('#ffffff').setFontWeight('bold').setFontSize(11).setHorizontalAlignment('left');
    sheet.setRowHeight(START + r - 1, 26);
  });
  seriesBands.forEach(function (r) {
    var rng = sheet.getRange(START + r - 1, 1, 1, COLS - 1);
    rng.setBackground('#e2f1ef').setFontColor('#0e6f6a').setFontWeight('bold');
    sheet.getRange(START + r - 1, 2).setHorizontalAlignment('left');
    sheet.getRange(START + r - 1, 1, 1, COLS - 1).setBorder(true, null, null, null, null, null, '#0e6f6a', SpreadsheetApp.BorderStyle.SOLID);
  });
  // 품목행: 실사칸 노랑 + 얇은 가로 격자
  itemRows.forEach(function (r) { sheet.getRange(START + r - 1, 9).setBackground('#fff9c4'); });
  sheet.getRange(START, 1, out.length, COLS - 1).setBorder(null, null, null, null, null, true, '#dde3e7', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(START, 1, out.length, COLS - 1).setBorder(null, true, null, true, true, null, '#dde3e7', SpreadsheetApp.BorderStyle.SOLID);
  sheet.hideColumns(12);
  sheet.setHiddenGridlines(true);
  sheet.showSheet();
  if (!quiet) ss.setActiveSheet(sheet);
  return items.length;
}

/** [_실사리스트] I열 실사값 → 활성 지점 재고 탭 G열 (원본행 기준, 코드 재확인) */
function applyCountSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(CONFIG.COUNT_SHEET);
  if (!sheet || sheet.getLastRow() < 3) { ui.alert('[_실사리스트]가 없습니다. 먼저 "실사 리스트 생성"을 실행하세요.'); return; }
  var title = String(sheet.getRange(1, 1).getValue());
  var bm = title.match(/^\[(.+?)\]/);
  if (!bm) { ui.alert('실사 리스트의 지점을 알 수 없습니다.'); return; }
  var main = ss.getSheetByName('재고_' + bm[1]);
  if (!main) { ui.alert('[재고_' + bm[1] + '] 탭이 없습니다.'); return; }
  var rows = sheet.getRange(3, 1, sheet.getLastRow() - 2, 12).getValues();
  var applied = 0, mismatch = [];
  rows.forEach(function (r) {
    var code = String(r[4] || '').trim(), val = r[8], srcRow = Number(r[11]);
    if (!code || val === '' || val == null || !srcRow) return;
    var mainCode = String(main.getRange(srcRow, COL.CODE).getValue() || '').trim();
    if (mainCode !== code) { mismatch.push(code); return; }
    main.getRange(srcRow, COL.COUNT).setValue(Number(val));
    applied++;
  });
  ss.setActiveSheet(main);
  ui.alert('✅ [' + bm[1] + '] 실사값 ' + applied + '건을 재고 탭 G열에 반영했습니다.' +
    (mismatch.length ? '\n⚠ 행 불일치로 건너뜀 ' + mismatch.length + '건 (재고 탭이 바뀐 뒤 리스트를 다시 생성하세요): ' + mismatch.slice(0, 10).join(', ') : '') +
    '\n\n이어서 ② 마감 전표 미리보기를 실행하세요.');
}

// ══════════════════════════ ⑩ 발주서 양식 (이카운트 발주계획 웹자료올리기) ══════════════════════════

var PO_HEADERS = ['일자', '순번', '담당자', '입고될창고', '거래유형', '통화', '환율', '납기일자', '참조', '프로젝트',
  '품목코드', '품목명', '거래처코드', '거래처명', '규격', '수량', '단가', '외화금액', '공급가액', '부가세', '적요', '단가(vat포함)', '박스단위'];

/** 발주 → 입고 납기일: 월→수, 수→금, 금→화(토 배송 없음), 그 외 요일은 +2영업일 */
function poDueDate_(d) {
  var dow = d.getDay(); // 0일 1월 2화 3수 4목 5금 6토
  var add = (dow === 5) ? 4 : (dow === 6) ? 3 : 2; // 금→화, 토→화, 그 외 +2
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + add);
}

/**
 * 활성 지점 재고 탭에서 발주수량(R)>0 품목을 뽑아 [_발주서] 탭에 이카운트 발주계획 양식(23열)으로 작성.
 * 거래처별 순번 묶음, 담당자=지점 담당자코드, 입고창고=지점 보관창고, 단가/거래처=품목 정보.
 * 코드매핑 대상은 대표코드(신코드)로 발주. 헤더 제외 데이터 행만 복사해 양식 2행부터 붙여넣으면 됨.
 */
function buildPurchaseOrderSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) { ui.alert('품목이 없습니다.'); return; }
  var data = main.getRange(startRow, 1, n, 20).getValues();

  // 품목 정보: 코드 → {구매처, 규격, 단가, 품목명}
  var info = {};
  var itemSheet = ss.getSheetByName(CONFIG.ITEM_SHEET);
  if (itemSheet) {
    itemSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      var cd = String(r[3] || '').trim();
      if (cd) info[cd] = { vendor: String(r[0] || '').trim(), size: String(r[5] || '').trim(), price: Number(r[7]) || 0, name: String(r[4] || '').trim() };
    });
  }
  var whMap = loadWhMap_(ss);
  var whCd = whMap[b.whStorage] || b.whStorage;
  var today = new Date();
  var ymd = Utilities.formatDate(today, 'Asia/Seoul', 'yyyyMMdd');
  var due = Utilities.formatDate(poDueDate_(today), 'Asia/Seoul', 'yyyyMMdd');

  var lines = [];
  data.forEach(function (r) {
    var code = String(r[COL.CODE - 1] || '').trim();
    var qty = Number(r[COL.ORDER - 1]);
    if (!code || !(qty > 0)) return;
    var it = info[code] || {};
    var vendor = it.vendor || String(r[COL.VENDOR - 1] || '').trim();
    var price = it.price || 0;
    var supply = Math.round(qty * price);
    lines.push({ vendor: vendor, row: [
      ymd, '', b.emp, whCd, CONFIG.PO_TRADE_TYPE, '', '', due, '', '',
      code, it.name || String(r[COL.NAME - 1] || ''), '', vendor, it.size || '',
      qty, price, '', supply, Math.round(supply * CONFIG.VAT_RATE), '[' + b.name + '] 자동발주 ' + Utilities.formatDate(today, 'Asia/Seoul', 'M/d'), '', ''
    ]});
  });
  if (!lines.length) { ui.alert('[' + b.name + '] 발주수량이 0보다 큰 품목이 없습니다.'); return; }

  // 거래처별 순번 (같은 거래처 = 같은 전표), 거래처명 정렬
  lines.sort(function (a, b2) { return a.vendor < b2.vendor ? -1 : a.vendor > b2.vendor ? 1 : 0; });
  var serial = 0, lastVendor = null, noVendor = 0;
  lines.forEach(function (l) {
    if (l.vendor !== lastVendor) { serial++; lastVendor = l.vendor; }
    if (!l.vendor) noVendor++;
    l.row[1] = String(serial);
  });

  var sheet = ss.getSheetByName(CONFIG.PO_SHEET);
  if (sheet) sheet.clear();
  else sheet = ss.insertSheet(CONFIG.PO_SHEET, ss.getSheets().length);
  sheet.getRange(1, 1).setValue('[' + b.name + '] 발주계획 ' + ymd + ' — 이카운트 발주계획 웹자료올리기 양식. 3행부터 끝까지 복사 → 양식(Template.xlsx) 2행에 붙여넣기. 순번=거래처별 전표 묶음, 납기 ' + due + '. 수량·단가는 수정 가능');
  sheet.getRange(2, 1, 1, PO_HEADERS.length).setValues([PO_HEADERS]).setFontWeight('bold').setBackground('#e2f1ef');
  // 코드류 열(일자·순번·담당자·창고·거래유형·납기·품목코드·거래처코드)은 텍스트로 — 앞의 0 보존, 소수점 방지
  [1, 2, 3, 4, 5, 8, 11, 13].forEach(function (c) { sheet.getRange(3, c, lines.length, 1).setNumberFormat('@'); });
  sheet.getRange(3, 1, lines.length, PO_HEADERS.length).setValues(lines.map(function (l) {
    var r = l.row.slice();
    [0, 1, 2, 3, 4, 7, 10, 12].forEach(function (i) { r[i] = String(r[i] == null ? '' : r[i]); });
    return r;
  }));
  sheet.setFrozenRows(2);
  sheet.setColumnWidth(12, 220); sheet.setColumnWidth(14, 160); sheet.setColumnWidth(21, 160);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  var vendors = {};
  lines.forEach(function (l) { vendors[l.vendor || '(구매처 없음)'] = (vendors[l.vendor || '(구매처 없음)'] || 0) + 1; });
  ui.alert('✅ [' + b.name + '] 발주서 ' + lines.length + '품목 / 거래처 ' + serial + '건 생성\n' +
    Object.keys(vendors).map(function (v) { return '· ' + v + ': ' + vendors[v] + '품목'; }).join('\n') +
    (noVendor ? '\n\n⚠ 구매처 없는 품목 ' + noVendor + '건 — 거래처명(N열) 직접 입력' : '') +
    '\n\n[_발주서] 탭 3행부터 복사 → 이카운트 발주계획 웹자료올리기 양식 2행에 붙여넣기');
}

/** 기존 재고탭을 새 발주 블록(일사용량·커버일수·목표재고·발주수량·창고인가량)으로 갱신 — 데이터는 유지 */
function upgradeStockTabLayout() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var b;
  try { b = branchFromActive_(ss); } catch (e) { ui.alert(e.message); return; }
  var main = b.sheet;
  var startRow = CONFIG.DATA_START_ROW;
  var n = main.getLastRow() - startRow + 1;
  if (n <= 0) { ui.alert('품목이 없습니다.'); return; }
  writeStockHeaders_(main);
  writeStockFormulas_(main, startRow, n);
  // 커버일수(P) 비어 있으면 지점 기본값으로
  var cover = b.coverDays || CONFIG.DEFAULT_COVER_DAYS;
  var pVals = main.getRange(startRow, COL.DAYS, n, 1).getValues().map(function (r) { return [r[0] === '' || r[0] == null ? cover : r[0]]; });
  main.getRange(startRow, COL.DAYS, n, 1).setValues(pVals);
  main.setColumnWidth(COL.WH_ALLOW, 90);
  ui.alert('✅ [' + b.name + '] 발주 블록 갱신 완료\n· O 일사용량(자동) · P 커버일수(기본 ' + cover + ') · Q 목표재고 · R 발주수량 · T 창고 인가량\n· ① 아침 준비를 실행하면 일사용량이 채워집니다.');
}

// ══════════════════════════ ⓪ 새 구조 초기 구축 ══════════════════════════

function buildNewStructure() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var mainName = '재고_' + CONFIG.DEFAULT_BRANCH.name;
  if (ss.getSheetByName(mainName) || ss.getSheetByName(CONFIG.MAIN_SHEET)) {
    ui.alert('"' + mainName + '" 탭이 이미 있습니다. 초기 구축은 최초 1회만 실행하세요.');
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
  buildStockTabFrame_(ss, mainName, rows);

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
  var map = loadCodeMap_(ss);
  var bal = pivotBalance_(rows, b, map);

  var startRow = CONFIG.DATA_START_ROW;
  var lastRow = main.getLastRow();
  var n = lastRow - startRow + 1;
  if (n <= 0) { ui.alert('[재고] 탭에 품목이 없습니다.'); return; }
  var codes = main.getRange(startRow, COL.CODE, n, 1).getValues();

  // 일사용량: 일별기록 최근 30일 판매 합계 ÷ 30 (기록 14일 미만이면 Supabase 수불부 월 usage_qty ÷ 30 대체)
  var usageRes = computeDailyUsage_(ss, b, map);
  var usage = usageRes.usage;

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

  // 발주 커버일수(P) 지점 기본값으로 리셋 (연휴 전에 늘렸던 값을 매일 원복)
  var cover = b.coverDays || CONFIG.DEFAULT_COVER_DAYS;
  main.getRange(startRow, COL.DAYS, n, 1).setValues(codes.map(function (row) { return [row[0] ? cover : '']; }));

  // 입력칸 초기화 (실사/환입/구매입고/페일)
  [COL.COUNT, COL.RET, COL.PURCHASE, COL.FAIL].forEach(function (c) {
    main.getRange(startRow, c, n, 1).clearContent();
  });

  // 실사 리스트도 오늘 값으로 자동 재생성 (전일재고·창고재고 갱신분 반영)
  var countMsg = '';
  try { var cnt = buildCountSheet_(ss, b, true); countMsg = '· 실사 리스트(_실사리스트) ' + cnt + '품목 재생성\n'; }
  catch (e) { countMsg = '· ⚠ 실사 리스트 생성 실패: ' + String(e.message).slice(0, 60) + '\n'; }
  ss.setActiveSheet(main);

  ui.alert('✅ [' + b.name + '] 아침 준비 완료 (기준일: ' + Utilities.formatDate(prevDate, 'Asia/Seoul', 'M/d') + ' 마감)\n' +
    '· 전일 중앙재고 / 창고·수술방 실재고 자동 입력\n' +
    '· 실사·환입·구매입고·페일 입력칸 초기화, 발주 커버일수 ' + cover + '일로 리셋\n' +
    '· 일사용량: ' + usageRes.source + '\n' + countMsg + '\n' +
    '실사는 [_실사리스트] I열에 입력 → "⑩ 실사 리스트 → 재고 탭 반영"  (또는 재고 탭 G열에 직접 입력)\n연휴 전 발주는 P열 커버일수를 늘리면 발주수량이 재계산됩니다.');
}

/**
 * 일사용량 계산.
 *  1) 일별기록 해당 지점 최근 USAGE_WINDOW_DAYS(30)일 판매 합계 ÷ 30 — 기록일수가 USAGE_MIN_DAYS 이상일 때
 *  2) 아니면 Supabase stock_ledger_sync 최근 마감월 usage_qty ÷ 30 (지점·품목코드, 코드매핑으로 대표코드 합산)
 * 반환 { usage: {code: 일사용량}, source: 설명 }
 */
function computeDailyUsage_(ss, b, map) {
  var W = CONFIG.USAGE_WINDOW_DAYS;
  var log = ss.getSheetByName(CONFIG.LOG_SHEET);
  var sum = {}, daysSet = {};
  if (log && log.getLastRow() > 1) {
    var hasBranchCol = String(log.getRange(1, 2).getValue()) === '지점';
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - W);
    var cutoffYmd = Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyyMMdd');
    log.getRange(2, 1, log.getLastRow() - 1, 7).getValues().forEach(function (r) {
      var ymd = String(r[0]);
      if (ymd < cutoffYmd) return;
      var branch = hasBranchCol ? String(r[1]) : CONFIG.DEFAULT_BRANCH.name;
      if (branch !== b.name) return;
      var cd = String(r[hasBranchCol ? 2 : 1]);
      var saleVal = r[hasBranchCol ? 6 : 5];
      var sale = Number(saleVal);
      if (!cd || saleVal === '' || isNaN(sale)) return;
      var rep = map ? repCode_(map, cd) : cd;
      sum[rep] = (sum[rep] || 0) + sale;
      daysSet[ymd] = true;
    });
  }
  var nDays = Object.keys(daysSet).length;
  var usage = {};
  if (nDays >= CONFIG.USAGE_MIN_DAYS) {
    Object.keys(sum).forEach(function (cd) { usage[cd] = Math.round(sum[cd] / W * 100) / 100; });
    return { usage: usage, source: '일별기록 최근 ' + W + '일 판매 ÷ ' + W + ' (기록 ' + nDays + '일)' };
  }
  // 대체: Supabase 수불부
  try {
    var sb = fetchSupabaseUsage_(b.name);
    if (sb && sb.rows.length) {
      sb.rows.forEach(function (r) {
        var rep = map ? repCode_(map, r.item_code) : r.item_code;
        usage[rep] = (usage[rep] || 0) + Number(r.usage_qty || 0);
      });
      Object.keys(usage).forEach(function (cd) { usage[cd] = Math.round(usage[cd] / 30 * 100) / 100; });
      return { usage: usage, source: 'ERP 수불부 ' + sb.yearMonth + ' 사용량 ÷ 30 (일별기록 ' + nDays + '일뿐이라 대체)' };
    }
  } catch (e) {
    return { usage: {}, source: '⚠ 계산 불가 — 일별기록 ' + nDays + '일, ERP 수불부 조회 실패: ' + String(e.message).slice(0, 80) };
  }
  return { usage: {}, source: '⚠ 계산 불가 — 일별기록 ' + nDays + '일뿐, ERP 수불부에 해당 지점 데이터 없음' };
}

/** Supabase stock_ledger_sync에서 지점의 최근 마감월 usage_qty 조회 */
function fetchSupabaseUsage_(branchName) {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('SB_URL'), key = p.getProperty('SB_KEY');
  if (!url || !key) throw new Error('Supabase 미설정 ("⚙ API 설정"에서 SB_URL/SB_KEY 입력)');
  var dbBranch = CONFIG.SB_BRANCH_NAME[branchName] || branchName.replace(/점$/, '');
  var hdr = { 'apikey': key, 'Authorization': 'Bearer ' + key };
  // 최근 마감월
  var r1 = UrlFetchApp.fetch(url + '/rest/v1/' + CONFIG.SB_TABLE + '?select=year_month&branch_name=eq.' + encodeURIComponent(dbBranch) + '&order=year_month.desc&limit=1', { headers: hdr, muteHttpExceptions: true });
  if (r1.getResponseCode() !== 200) throw new Error('Supabase HTTP ' + r1.getResponseCode());
  var ymRows = JSON.parse(r1.getContentText());
  if (!ymRows.length) return { yearMonth: null, rows: [] };
  var ym = ymRows[0].year_month;
  var rows = [], offset = 0;
  while (true) {
    var r2 = UrlFetchApp.fetch(url + '/rest/v1/' + CONFIG.SB_TABLE + '?select=item_code,usage_qty&branch_name=eq.' + encodeURIComponent(dbBranch) + '&year_month=eq.' + ym + '&offset=' + offset + '&limit=1000', { headers: hdr, muteHttpExceptions: true });
    if (r2.getResponseCode() !== 200) throw new Error('Supabase HTTP ' + r2.getResponseCode());
    var chunk = JSON.parse(r2.getContentText());
    rows = rows.concat(chunk);
    if (chunk.length < 1000) break;
    offset += 1000;
  }
  return { yearMonth: ym, rows: rows };
}

/**
 * API 응답 → 품목코드별 [중앙, 창고, 수술방] 잔고 (지점 창고 기준).
 * map(코드매핑)이 있으면 구코드 재고를 대표코드로 합산. bal.__raw 에는 코드별 원본 잔고 유지.
 */
function pivotBalance_(rows, b, map) {
  var slotMap = {};
  slotMap[normalize_(b.whCentral)] = 0;
  slotMap[normalize_(b.whStorage)] = 1;
  slotMap[normalize_(b.whSurgery)] = 2;
  var bal = {}, raw = {};
  rows.forEach(function (r) {
    var cd = String(firstOf_(r, ['PROD_CD']) || '').trim();
    var qty = Number(firstOf_(r, ['BAL_QTY']) || 0);
    if (!cd || !qty) return;
    var slot = slotMap[normalize_(String(firstOf_(r, ['WH_DES']) || ''))];
    if (slot == null) return;
    if (!raw[cd]) raw[cd] = [0, 0, 0];
    raw[cd][slot] += qty;
    var rep = map ? repCode_(map, cd) : cd;
    if (!bal[rep]) bal[rep] = [0, 0, 0];
    bal[rep][slot] += qty;
  });
  Object.defineProperty(bal, '__raw', { value: raw, enumerable: false });
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
      if (r[3] !== '' && r[3] != null) itemInfo[String(r[3])] = { price: Number(r[7]) || 0, size: String(r[5] || ''), cat: String(r[2] || '') };
    });
  }

  // 코드매핑: 대표코드 행의 수량을 구코드 재고부터 소진하도록 분배 (선입선출). 원본 코드별 재고는 오늘 기준 API
  var map = loadCodeMap_(ss);
  var hasMap = Object.keys(map.siblings).length > 0;
  var raw = {};
  if (hasMap) {
    var balNow = pivotBalance_(ecountFetchInventory(ymdToday), b, map);
    raw = balNow.__raw || {};
  }
  // slot: 0 중앙, 1 창고, 2 수술방 — 출고 원천 창고 기준으로 분배
  function split(rep, qty, slot) {
    if (!hasMap || !map.siblings[rep]) return [{ code: rep, qty: qty }];
    var byCode = {};
    Object.keys(raw).forEach(function (c) { byCode[c] = raw[c][slot]; });
    return splitQtyFifo_(map, rep, qty, byCode);
  }
  function nameOf(cd, fallback) { return cd === fallback.code ? fallback.name : (fallback.name + ' [' + cd + ']'); }

  // 품목을 실사리스트와 같은 순서(중분류→계열→Ø→L)로 정렬한 뒤 전표 종류별 섹션으로 묶는다
  var entries = [];
  data.forEach(function (r) {
    var code = String(r[COL.CODE - 1] || '').trim();
    if (!code) return;
    var name = String(r[COL.NAME - 1] || '');
    var info = itemInfo[code] || {};
    var k = sizeKey_(name, info.size);
    entries.push({
      code: code, name: name,
      cat: String(r[COL.CAT - 1] || '').trim() || info.cat || '기타',
      series: k.series, dia: k.dia, len: k.len,
      sale: Number(r[COL.SALE - 1]) || 0,
      need: Number(r[COL.NEED - 1]) || 0,
      ret: Number(r[COL.RET - 1]) || 0,
      whStock: Number(r[COL.STORAGE - 1]) || 0   // J 창고 실재고 (이동 가능 상한)
    });
  });
  entries.sort(countCompare_);

  var secSale = [], secCS = [], secWC = [], secRet = [], shortage = [];
  entries.forEach(function (e) {
    var fb = { code: e.code, name: e.name };
    if (e.sale > 0) {
      split(e.code, e.sale, 2).forEach(function (p) {
        secSale.push([b.name, '판매', ymdPrev, b.whSurgery, '', p.code, nameOf(p.code, fb), p.qty, (itemInfo[p.code] || itemInfo[e.code] || {}).price || 0, '대기', '']);
      });
      split(e.code, e.sale, 0).forEach(function (p) {
        secCS.push([b.name, '이동', ymdPrev, b.whCentral, b.whSurgery, p.code, nameOf(p.code, fb), p.qty, '', '대기', '']);
      });
    }
    if (e.need > 0) {
      // 창고 실재고를 넘는 수량은 이동 불가 → 이동수량 = MIN(부족수량, 창고재고). 못 채운 만큼은 경고(발주로 커버)
      var mv = Math.min(e.need, Math.max(0, e.whStock));
      var short = e.need - mv;
      if (short > 0) shortage.push(e.code + ' ' + e.name.slice(0, 12) + ': 필요 ' + e.need + ' 중 ' + mv + '만 이동 (창고재고 ' + e.whStock + ')');
      if (mv > 0) split(e.code, mv, 1).forEach(function (p) {
        secWC.push([b.name, '이동', ymdToday, b.whStorage, b.whCentral, p.code, nameOf(p.code, fb) + (short > 0 ? ' ⚠창고부족' : ''), p.qty, '', '대기', '']);
      });
    }
    if (e.ret > 0) split(e.code, e.ret, 0).forEach(function (p) {
      secRet.push([b.name, '환입', ymdToday, b.whCentral, b.whStorage, p.code, nameOf(p.code, fb), p.qty, '', '대기', '']);
    });
  });

  if (!secSale.length && !secCS.length && !secWC.length && !secRet.length) {
    ui.alert('전송할 내역이 없습니다. (실사값 입력 후 실행하세요)'); return;
  }

  // 섹션 조립: 밴드 행(코드·수량 없음 → 전송에서 자동 제외)
  var out = [], bandIdx = [];
  function addSection(title, rows2) {
    if (!rows2.length) return;
    out.push([b.name, '▶ ' + title, '', '', '', '', '', '', '', '', '']);
    bandIdx.push(out.length);
    rows2.forEach(function (r) { out.push(r); });
  }
  addSection('판매 — 수술방 출고 (' + ymdPrev + ')', secSale);
  addSection('이동 — 중앙공급실 → 수술방 (' + ymdPrev + ')', secCS);
  addSection('이동 — 창고 → 중앙공급실 (' + ymdToday + ')', secWC);
  addSection('환입 — 중앙공급실 → 창고 (' + ymdToday + ')', secRet);

  // 이미 전송된 키(중복 방지)
  var sentKeys = getSentKeys_();
  var dup = 0;
  out.forEach(function (r) {
    var key = slipKey_(r);
    if (sentKeys[key]) { r[9] = '기전송(자동 제외)'; dup++; }
  });

  var sheet = ss.getSheetByName(CONFIG.PREVIEW_SHEET);
  if (sheet) { sheet.clear(); }
  else sheet = ss.insertSheet(CONFIG.PREVIEW_SHEET, ss.getSheets().length);
  sheet.getRange(1, 1).setValue('[' + b.name + '] 전송 전 검토용 — 수량 수정 가능, 빼려면 행 삭제 또는 수량 0. 검토 후 "③ 전표 전송" 실행' +
    (shortage.length ? '   ⚠ 창고재고 부족 ' + shortage.length + '건 (이동수량 제한 — 발주 필요)' : ''));
  sheet.getRange(1, 1).setFontWeight('bold').setFontColor(shortage.length ? '#a35a0c' : '#0e6f6a');
  sheet.getRange(2, 1, 1, 11).setValues([['지점', '구분', '일자', '보내는창고/판매창고', '받는창고', '품목코드', '품목명', '수량', '단가(판매만)', '상태', '전표결과']])
    .setFontWeight('bold').setBackground('#0e6f6a').setFontColor('#ffffff');
  sheet.getRange(3, 1, out.length, 11).setValues(out).setFontSize(10);
  sheet.setFrozenRows(2);
  bandIdx.forEach(function (r) {
    sheet.getRange(2 + r, 1, 1, 11).setBackground('#e2f1ef').setFontColor('#0e6f6a').setFontWeight('bold');
    sheet.setRowHeight(2 + r, 24);
  });
  sheet.setColumnWidth(4, 200); sheet.setColumnWidth(5, 200); sheet.setColumnWidth(7, 220);
  sheet.showSheet();
  ss.setActiveSheet(sheet);

  var cnt = { '판매': 0, '이동': 0, '환입': 0 };
  out.forEach(function (r) { if (r[9] === '대기') cnt[r[1]]++; });
  ui.alert('[' + b.name + '] 전표 초안 생성 완료 — 판매 ' + cnt['판매'] + '건, 이동 ' + cnt['이동'] + '건, 환입 ' + cnt['환입'] + '건' +
    (dup ? '\n(기전송 ' + dup + '건 자동 제외)' : '') +
    (shortage.length ? '\n\n⚠ 창고재고 부족 ' + shortage.length + '건 — 부족분은 이동에서 제외됨 (발주수량에 반영):\n' + shortage.slice(0, 8).join('\n') + (shortage.length > 8 ? '\n…' : '') : '') +
    '\n\n"' + CONFIG.PREVIEW_SHEET + '" 탭에서 검토·수정 후 "③ 전표 전송"을 실행하세요.');
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
  var bal = pivotBalance_(apiRows, b, loadCodeMap_(ss));

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
    'RELAY_TOKEN|중계 토큰 (서버 ECOUNT_RELAY_TOKEN과 동일 값)',
    'SB_URL|Supabase URL (새 ERP 수불부 — 일사용량 대체 소스, 예: https://xxxx.supabase.co)',
    'SB_KEY|Supabase anon key'
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
