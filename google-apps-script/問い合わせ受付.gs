/**
 * =============================================================
 * 問い合わせの受付（Googleスプレッドシートへ記録＋Gmailで通知）
 * -------------------------------------------------------------
 * 使い方は DEPLOY.md の「問い合わせの設定」を参照してください。
 *
 * このスクリプトのURLと合言葉(SHARED_SECRET)は、Supabaseのシークレットにのみ
 * 登録します。ブラウザ側のコードには出さないため、URLを直接叩かれる心配を減らせます。
 * =============================================================
 */

/** スクリプトプロパティから設定を読む（コードに直接書かない） */
function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    secret: p.getProperty('SHARED_SECRET'),   // Supabase側と同じ合言葉
    sheetId: p.getProperty('SHEET_ID'),       // 記録先スプレッドシートのID
    notifyTo: p.getProperty('NOTIFY_TO'),     // 通知先メールアドレス
  };
}

const SHEET_NAME = '問い合わせ';
const HEADERS = ['受信日時', '種別', 'お名前', 'メールアドレス', '内容', '会員種別', '利用環境', 'ユーザーID'];

/** 記録先のシートを取得（なければ見出し付きで作る） */
function getSheet_(sheetId) {
  const book = SpreadsheetApp.openById(sheetId);
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(5, 420);   // 内容の列を広めに
  }
  return sheet;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const cfg = getConfig_();
    if (!cfg.secret || !cfg.sheetId) {
      return jsonOut_({ ok: false, error: 'スクリプトプロパティが未設定です' });
    }

    const data = JSON.parse(e.postData.contents || '{}');

    // 合言葉が一致しない呼び出しは拒否する
    if (data.secret !== cfg.secret) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    const now = new Date();
    const row = [
      now,
      String(data.category || '未分類'),
      String(data.name || ''),
      String(data.email || ''),
      String(data.message || ''),
      String(data.plan || ''),
      String(data.userAgent || ''),
      String(data.userId || ''),
    ];
    getSheet_(cfg.sheetId).appendRow(row);

    // Gmailで通知（このスクリプトの所有者のアカウントから送信されます）
    if (cfg.notifyTo) {
      const body = [
        '席メイトに問い合わせが届きました。',
        '',
        '受信日時：' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
        '種別　　：' + row[1],
        'お名前　：' + row[2],
        'メール　：' + row[3],
        '会員種別：' + row[5],
        '利用環境：' + row[6],
        '',
        '--- 内容 ---',
        row[4],
        '',
        '--- 記録先 ---',
        'https://docs.google.com/spreadsheets/d/' + cfg.sheetId,
      ].join('\n');

      MailApp.sendEmail({
        to: cfg.notifyTo,
        subject: '【席メイト】問い合わせ（' + row[1] + '）',
        body: body,
        // 返信するとそのまま問い合わせ者へ返せるようにする
        replyTo: row[3] || undefined,
        name: '席メイト',
      });
    }

    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** 動作確認用。エディタから実行して、シート作成とメール送信を試せます。 */
function testSend() {
  const cfg = getConfig_();
  doPost({
    postData: {
      contents: JSON.stringify({
        secret: cfg.secret,
        category: '動作確認',
        name: 'テスト太郎',
        email: 'test@example.com',
        message: 'これはテスト送信です。',
        plan: 'free',
        userAgent: 'GAS test',
        userId: 'test-user',
      }),
    },
  });
}
