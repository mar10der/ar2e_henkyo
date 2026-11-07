'use strict';
// node tests/enemy-identify.cjs
// Node.js 22+ / Chrome（CHROME_PATHでも指定可）。外部通信せず、実ブラウザーで確認する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'enemy_Identify.html'), 'utf8');
new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const screenshotDir = process.env.SCREENSHOT_DIR;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'enemy-identify-browser-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, ws, appServer, apiServer, sequence = 0;
const pending = new Map();
const pageErrors = [];
const requests = [];
const passed = [];
let apiOrigin;

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await delay(40);
  }
  throw Error('Condition timed out: ' + expression);
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
async function load(id, extra = '') {
  await evaluate(`$('sheetUrl').value = ${JSON.stringify(apiOrigin + '/?id=' + id + extra)}; $('loadForm').requestSubmit();`);
  await until(`!$('loadButton').disabled`);
}
async function check(name, fn) { await fn(); passed.push(name); }

async function main() {
  const chromePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(file => fs.existsSync(file));
  assert.ok(chromePath, 'Chromeが見つかりません。CHROME_PATHを指定してください。');
  appServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); res.end(html);
  });
  const appOrigin = await listen(appServer);
  // 検証専用の架空データ。配布HTMLには含めない。
  const fixture = {
      type:"e", enemyName:"エネミーさん", taxon:"魔族", element:"―", level:"25", identifyTarget:"30",
      armorP:"25", armorM:"16", hp:"100", mp:"50", initiative:"13", mobility:"22", dodge:"12", dodgeDice:"2",
      sttStrBase:"37", sttDexBase:"32", sttAgiBase:"17", sttIntBase:"14", sttSenBase:"22", sttMndBase:"16", sttLukBase:"18",
      attackNum:"1", attack1Name:"翼の指先(格闘/双)", attack1Acc:"8", attack1AccDice:"2", attack1Dmg:"16", attack1DmgDice:"4", attack1Type:"白兵", attack1DmgType:"物理", attack1Range:"至近",
      skills:"《エネミースキルです》1：パッシブ。このキャラクターは人間ではない別の分類として扱う。\n《飛行能力》1\n《よろしく》1：パッシブ。あなた以外の同エンゲージのエネミーに有効。対象が行なう判定の達成値に+4する。\n《ハリボテの魅了》1：セットアッププロセス。HPが一定以下で使用可能。視界内の場面（選択）と【精神】による対決を行なう。対決に勝利した場合、対象に[スタン]を与える。\n《ブレス：水》1《射程延長》4：メジャーアクション。40m以内の範囲（選択）に特殊攻撃を行なう。水魔法ダメージを与える。\n《がんばれ》5：判定の直前。20m以内の単体。対象の判定の達成値に+4する。1シナリオにSL回使用可能。",
      description:"このエネミーは強いですよ。", lootNum:"4",
      loot1Num:"5～8", loot1Item:"魔族の羽根(100G)×4", loot2Num:"9～11", loot2Item:"魔力の欠片(200G)×4",
      loot3Num:"12～14", loot3Item:"魔族の心臓(800G)×2", loot4Num:"15～ ", loot4Item:"ナベリウスの手(3500G)"
    };
  apiServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.search);
    if (url.searchParams.get('id') !== 'cors') res.setHeader('Access-Control-Allow-Origin', '*');
    const id = url.searchParams.get('id');
    if (id === '403' || id === '404' || id === '500') { res.writeHead(Number(id)); res.end('Unavailable'); return; }
    if (id === 'html') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Not JSON</h1>'); return; }
    const data = id === 'pc' ? { type:'c', characterName:'PC' }
      : id === 'array' ? []
      : id === 'error' ? { result:'ERROR', enemyName:'Error' }
      : id === 'mob' ? { ...fixture, enemyName:'モブ試験', isMob:'1', action:'0', reaction:'3', mp:undefined, armorP:'0', armorM:'5', element:'火,闇' }
      : id === 'entities' ? { ...fixture, enemyName:'&lt;img src=x onerror=alert(1)&gt;', skills:'一行目&lt;br&gt;二行目 &amp; &amp;lt;br&amp;gt;', description:'&lt;script&gt;window.injected=1&lt;/script&gt;' }
      : fixture;
    const send = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (id === 'slow') setTimeout(send, 500); else send();
  });
  apiOrigin = await listen(apiServer);
  browser = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide:true, stdio:['ignore','ignore','pipe'] });
  let stderr = '';
  browser.stderr.on('data', bytes => stderr += bytes);
  browser.on('error', error => stderr += error.stack);
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
    if (browser.exitCode !== null) throw Error(stderr);
    await delay(100);
  }
  assert.ok(fs.existsSync(portFile), 'Chrome did not start: ' + stderr);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once:true });
    ws.addEventListener('error', reject, { once:true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params);
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Network.enable');
  await command('Network.setBlockedURLs', { urls:['https://*'] });
  await command('Emulation.setDeviceMetricsOverride', { width:1360, height:1120, deviceScaleFactor:1, mobile:false });
  const pageUrl = appOrigin + '/enemy_Identify.html';
  await command('Page.navigate', { url:pageUrl });
  await until(`typeof optionControls !== 'undefined' && optionControls.size === 17`);

  await check('指定の17項目と7項目の初期選択、初期コピー無効', async () => {
    assert.equal(await evaluate(`$('selectedCount').textContent`), '7 / 17 項目');
    assert.equal(await evaluate(`$('copyButton').disabled`), true);
    assert.deepEqual(await evaluate(`Object.entries(selection()).filter(([,v])=>v && v !== 'none').map(([k])=>k)`), ['name','kind','taxon','defense','element','level','skills']);
    assert.equal(await evaluate(`selection().defense`), 'compare');
    assert.equal(await evaluate(`selection().skills`), 'named');
    assert.equal(await evaluate(`document.querySelectorAll('input[type=checkbox]').length`), 15);
    assert.equal(await evaluate(`document.querySelectorAll('input[type=radio]').length`), 6);
  });
  await check('初期出力とユーザー例の全文整形', async () => {
    await load('solo');
    assert.equal(await evaluate(`$('output').value`), `名称：エネミーさん\nソロエネミー\n分類：魔族、属性：-、EL：25\n物理防御力の方が高い\n\nエネミースキル：\n${fixture.skills}`);
    await evaluate(`$('allButton').click()`);
    assert.equal(await evaluate(`$('output').value`), `名称：エネミーさん
ソロエネミー
分類：魔族、属性：-、EL：25
識別値：30
防御力：25／16

能力値：
筋力：37／12
器用：32／10
敏捷：17／5
知力：14／4
感知：22／7
精神：16／5
幸運：18／6

HP：100、MP：50、行動値：13、移動力：22
回避：12+2D

攻撃：
翼の指先(格闘/双)、命中：8+2D/ダメージ16+4D、白兵(物理)、至近

エネミースキル：
${fixture.skills}

解説：
このエネミーは強いですよ。

ドロップ品：
5～8：魔族の羽根(100G)×4
9～11：魔力の欠片(200G)×4
12～14：魔族の心臓(800G)×2
15～：ナベリウスの手(3500G)`);
  });
  await check('項目を個別選択、全解除、初期設定', async () => {
    for (const key of await evaluate(`FIELDS.map(([key])=>key)`)) {
      const result = await evaluate(`setPreset('none'); setOption(${JSON.stringify(key)}, FIELDS.find(([key])=>key===${JSON.stringify(key)})[3]?.[1][0] ?? true); optionsChanged(); ({text:$('output').value, count:$('selectedCount').textContent})`);
      assert.ok(result.text); assert.equal(result.count, '1 / 17 項目');
      if (key === 'hp') assert.equal(result.text, 'HP：100');
      if (key === 'taxon') assert.equal(result.text, '分類：魔族');
    }
    await evaluate(`$('noneButton').click()`);
    assert.equal(await evaluate(`$('output').value`), '');
    assert.equal(await evaluate(`$('copyButton').disabled`), true);
    await evaluate(`$('defaultButton').click()`);
    assert.equal(await evaluate(`$('selectedCount').textContent`), '7 / 17 項目');
  });
  await check('防御力の三択が排他的に切り替わり、比較・物理／魔法の数値を出力', async () => {
    const cases = [['none',''], ['compare','物理防御力の方が高い'], ['values','防御力：25／16']];
    for (const [mode, expected] of cases) {
      await evaluate(`setPreset('none'); document.querySelector('input[name="defense"][value="${mode}"]').click()`);
      assert.equal(await evaluate(`$('output').value`), expected);
      assert.equal(await evaluate(`document.querySelectorAll('input[name="defense"]:checked').length`), 1);
      assert.equal(await evaluate(`$('copyButton').disabled`), mode === 'none');
    }
    assert.equal(await evaluate(`buildOutput({armorP:'9',armorM:'12'}, {defense:'compare'})`), '魔法防御力の方が高い');
    assert.equal(await evaluate(`buildOutput({armorP:'12',armorM:'12'}, {defense:'compare'})`), '物理防御力と魔法防御力が同じ');
    assert.equal(await evaluate(`buildOutput({armorP:'0'}, {defense:'values'})`), '防御力：0／-');
  });
  await check('スキルの三択、行頭《の厳密な抽出、API改行と一致行なし', async () => {
    const raw = ' 《先頭に空白》1\n説明文\n《飛行能力》1\n　《全角空白》1\n途中《のスキル》1\n《ブレス》2：効果\n継続説明';
    await evaluate(`currentData={...${JSON.stringify(fixture)},skills:${JSON.stringify(raw)}}; setPreset('none')`);
    for (const [mode, expected] of [
      ['none', ''], ['named', 'エネミースキル：\n《飛行能力》1\n《ブレス》2：効果'], ['all', 'エネミースキル：\n' + raw.trim()]
    ]) {
      await evaluate(`document.querySelector('input[name="skills"][value="${mode}"]').click()`);
      assert.equal(await evaluate(`$('output').value`), expected);
      assert.equal(await evaluate(`document.querySelectorAll('input[name="skills"]:checked').length`), 1);
    }
    assert.equal(await evaluate(`buildOutput({skills:'説明&lt;br&gt;《飛行能力》1&lt;br&gt;続き'}, {skills:'named'})`), 'エネミースキル：\n《飛行能力》1');
    assert.equal(await evaluate(`buildOutput({skills:'説明文だけ'}, {skills:'named'})`), 'エネミースキル：\n-');
    assert.equal(await evaluate(`buildOutput({}, {skills:'all'})`), 'エネミースキル：\n-');
    await load('solo');
    await evaluate(`$('defaultButton').click()`);
  });
  await check('既存ツールと同じ二次創作・権利表記をフッターに表示', async () => {
    const footer = await evaluate(`document.querySelector('footer').textContent`);
    assert.ok(footer.includes('本作は、「著：菊池たけし／F.E.A.R」が権利を有する『アリアンロッドRPG2E』の二次創作作品です。'));
    assert.ok(footer.includes('(C)F.E.A.R. 「アリアンロッドRPG 2E」'));
  });
  await check('クロスオリジン実HTTP取得、過去ログ、操作パラメーターの除外', async () => {
    await load('solo', '&mode=save&callback=bad&url=https://example.com&log=old%2B1#section');
    assert.equal(await evaluate(`$('status').dataset.tone`), 'success');
    assert.equal(requests.at(-1), '?id=solo&log=old%2B1&mode=json');
    assert.equal(await evaluate(`currentData.enemyName`), 'エネミーさん');
  });
  await check('モブ、ゼロ値、複数属性、MP未設定、魔法防御優位', async () => {
    await evaluate(`$('allButton').click()`);
    await load('mob');
    const text = await evaluate(`$('output').value`);
    assert.ok(text.includes('モブエネミー\n'));
    assert.ok(text.includes('属性：火、闇'));
    assert.ok(text.includes('防御力：0／5'));
    assert.ok(text.includes('能力値：\n能動：0\n受動：3'));
    assert.ok(text.includes('HP：100、MP：-'));
  });
  await check('API文字参照一段の復号、改行、HTMLを実行しない', async () => {
    await load('entities');
    const text = await evaluate(`$('output').value`);
    assert.ok(text.includes('名称：<img src=x onerror=alert(1)>'));
    assert.ok(text.includes('一行目\n二行目 & &lt;br&gt;'));
    assert.ok(text.includes('<script>window.injected=1</script>'));
    assert.equal(await evaluate(`document.querySelector('img') === null && typeof window.injected === 'undefined'`), true);
    assert.equal(await evaluate(`decodeText(${JSON.stringify('&#x300A;テスト&#12299;\r\n次<br />行')})`), '《テスト》\n次\n行');
  });
  await check('同値・不明防御、欠損値、数値0、攻撃・ドロップの連番と空行', async () => {
    assert.equal(await evaluate(`buildOutput({armorP:'0',armorM:0},{defense:'compare'})`), '物理防御力と魔法防御力が同じ');
    assert.equal(await evaluate(`buildOutput({armorM:0},{defense:'compare'})`), '防御力の比較：不明');
    assert.equal(await evaluate(`diceText('0','0')`), '0+0D');
    assert.equal(await evaluate(`buildOutput({hp:0},{hp:true})`), 'HP：0');
    assert.equal(await evaluate(`buildOutput({}, {level:true, attacks:true, loot:true})`), 'EL：-\n\n攻撃：\n-\n\nドロップ品：\n-');
    assert.equal(await evaluate(`buildAttacks({attackNum:'4',attack3Name:'後',attack3Acc:0,attack3AccDice:2,attack1Name:'先',attack2Name:'',attack5Name:'範囲外'})`), '先、命中：-/ダメージ-、-、-\n後、命中：0+2D/ダメージ-、-、-');
    assert.equal(await evaluate(`buildLoot({lootNum:'4',loot3Num:'9～',loot3Item:'後',loot1Num:'0',loot1Item:'先',loot2Num:'5',loot4Item:''})`), '0：先\n9～：後');
  });
  await check('403・404・500・非JSON・別種別・配列・APIエラー・CORS拒否', async () => {
    const cases = [['403','閲覧制限'], ['404','見つかりません'], ['500','HTTP 500'], ['html','JSON'], ['pc','エネミーシートではありません'], ['array','JSON形式'], ['error','取得できません'], ['cors','通信できません']];
    for (const [id, message] of cases) {
      await load(id);
      assert.equal(await evaluate(`$('status').dataset.tone`), 'error', id);
      assert.ok((await evaluate(`$('status').textContent`)).includes(message), id);
      assert.equal(await evaluate(`$('output').value`), '', id);
      assert.equal(await evaluate(`$('copyButton').disabled`), true, id);
    }
  });
  await check('URL不正・ID欠損・不正スキームを通信前に拒否', async () => {
    const before = requests.length;
    for (const value of ['', 'example', 'https://example.com/', 'javascript:alert(1)', 'file:///tmp/test?id=1', 'https://user:pass@example.com/?id=1']) {
      await evaluate(`$('sheetUrl').value=${JSON.stringify(value)}; $('loadForm').requestSubmit()`);
      assert.equal(await evaluate(`$('status').dataset.tone`), 'error');
      assert.equal(await evaluate(`$('copyButton').disabled`), true);
    }
    assert.equal(requests.length, before);
  });
  await check('取得中のURL変更・再取得が古い応答を破棄', async () => {
    await evaluate(`$('sheetUrl').value=${JSON.stringify(apiOrigin + '/?id=slow')}; $('loadForm').requestSubmit()`);
    assert.equal(await evaluate(`$('loadButton').disabled`), true);
    await evaluate(`$('sheetUrl').value=${JSON.stringify(apiOrigin + '/?id=mob')}; $('sheetUrl').dispatchEvent(new Event('input'))`);
    await delay(600);
    assert.equal(await evaluate(`$('output').value`), '');
    await evaluate(`$('sheetUrl').value=${JSON.stringify(apiOrigin + '/?id=slow')}; $('loadForm').requestSubmit()`);
    await load('mob');
    await delay(600);
    assert.equal(await evaluate(`currentData.enemyName`), 'モブ試験');
    assert.equal(await evaluate(`$('loadButton').disabled`), false);
  });
  await check('15秒のタイムアウト後に再取得可能（テストでは時計を短縮）', async () => {
    await evaluate(`window.originalTimeout=window.setTimeout; window.setTimeout=(fn,ms,...args)=>window.originalTimeout(fn,ms===15000?30:ms,...args)`);
    await load('slow');
    assert.ok((await evaluate(`$('status').textContent`)).includes('タイムアウト'));
    assert.equal(await evaluate(`$('copyButton').disabled`), true);
    await evaluate(`window.setTimeout=window.originalTimeout`);
    await load('solo');
    assert.equal(await evaluate(`$('status').dataset.tone`), 'success');
  });
  await check('クリップボードAPIで実コピー、API拒否時と手動コピーへの案内', async () => {
    await command('Browser.grantPermissions', { origin:appOrigin, permissions:['clipboardReadWrite','clipboardSanitizedWrite'] });
    await command('Emulation.setFocusEmulationEnabled', { enabled:true });
    const clipboardBefore = await evaluate(`navigator.clipboard.readText()`);
    try {
      await evaluate(`copyOutput()`);
      const copied = await evaluate(`navigator.clipboard.readText()`);
      assert.equal(copied.replace(/\r\n/g, '\n'), await evaluate(`$('output').value`));
    } finally { await evaluate(`navigator.clipboard.writeText(${JSON.stringify(clipboardBefore)})`); }
    await evaluate(`window.originalWrite=navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText=async()=>{throw Error('Denied')}; window.originalExec=document.execCommand.bind(document); document.execCommand=()=>false; copyOutput()`);
    assert.ok((await evaluate(`$('status').textContent`)).includes('Ctrl+C'));
    assert.equal(await evaluate(`$('output').selectionEnd-$('output').selectionStart`), (await evaluate(`$('output').value`)).length);
    await evaluate(`document.execCommand=()=>true; copyOutput()`);
    assert.equal(await evaluate(`$('status').dataset.tone`), 'success');
    await evaluate(`document.execCommand=window.originalExec; navigator.clipboard.writeText=window.originalWrite`);
  });
  await check('設定だけを保存して再読込、URL・シート本文は保存しない', async () => {
    await evaluate(`$('noneButton').click(); optionControls.get('name')[0].click(); optionControls.get('hp')[0].click()`);
    const saved = await evaluate(`({...localStorage})`);
    assert.deepEqual(Object.keys(saved), ['ar2e.enemyIdentify.options.v1']);
    assert.equal(JSON.parse(saved['ar2e.enemyIdentify.options.v1']).hp, true);
    await command('Page.reload');
    await until(`document.readyState==='complete' && document.querySelectorAll('input[type=checkbox]').length===15`);
    assert.equal(await evaluate(`$('selectedCount').textContent`), '2 / 17 項目');
    assert.equal(await evaluate(`$('sheetUrl').value`), '');
    assert.equal(await evaluate(`$('output').value`), '');
    await evaluate(`$('defaultButton').click()`);
    await load('solo');
  });
  await check('三択の保存復元と旧チェック設定からの移行、不正設定時の初期値', async () => {
    await evaluate(`setPreset('none'); document.querySelector('input[name="defense"][value="values"]').click(); document.querySelector('input[name="skills"][value="all"]').click()`);
    await command('Page.reload');
    await until(`document.readyState==='complete' && document.querySelectorAll('input[type=radio]').length===6`);
    assert.equal(await evaluate(`selection().defense`), 'values');
    assert.equal(await evaluate(`selection().skills`), 'all');
    assert.equal(await evaluate(`$('selectedCount').textContent`), '2 / 17 項目');
    for (const [saved, defense, skills] of [
      [{defense:true,skills:true}, 'compare', 'named'],
      [{defense:false,skills:false}, 'none', 'none'],
      [{defense:'invalid',skills:'invalid'}, 'compare', 'named']
    ]) {
      await evaluate(`localStorage.setItem(STORAGE_KEY, ${JSON.stringify(JSON.stringify(saved))})`);
      await command('Page.reload');
      await until(`document.readyState==='complete' && document.querySelectorAll('input[type=radio]').length===6`);
      assert.equal(await evaluate(`selection().defense`), defense);
      assert.equal(await evaluate(`selection().skills`), skills);
    }
    await evaluate(`$('defaultButton').click()`);
    await load('solo');
  });
  await check('デスクトップ・スマートフォンで横にはみ出さない', async () => {
    if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive:true });
    for (const [name, width, height] of [['desktop',1360,1120], ['mobile',390,844]]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:width<760 });
      await delay(100);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, name);
      if (screenshotDir) {
        const shot = await command('Page.captureScreenshot', { format:'png', captureBeyondViewport:true });
        fs.writeFileSync(path.join(screenshotDir, 'enemy-identify-' + name + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }
  });
  await check('HTML単体のfile URLでも初期表示とコピーが機能する', async () => {
    const { pathToFileURL } = require('node:url');
    await command('Page.navigate', { url:pathToFileURL(path.join(root, 'enemy_Identify.html')).href });
    await until(`document.readyState==='complete' && document.querySelectorAll('input[type=checkbox]').length===15`);
    await load('solo');
    assert.ok((await evaluate(`$('output').value`)).includes('エネミーさん'));
    await evaluate(`window.originalExec=document.execCommand.bind(document); document.execCommand=()=>true; if(navigator.clipboard) navigator.clipboard.writeText=async()=>{throw Error('fallback')}; copyOutput()`);
    assert.equal(await evaluate(`$('status').dataset.tone`), 'success');
  });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed:passed.length, cases:passed, externalSheetTest:false }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (ws?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} }
  ws?.close();
  if (browser && browser.exitCode === null) browser.kill();
  appServer?.closeAllConnections(); appServer?.close();
  apiServer?.closeAllConnections(); apiServer?.close();
  // 一時プロファイルはOSの一時ディレクトリに限定して削除する。
  await delay(300);
  if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('enemy-identify-browser-')) {
    try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
  }
});
