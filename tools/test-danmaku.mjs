// The danmaku parsers decide what every comment on screen says, what colour it
// is and when it appears, from two formats whose field order disagrees. Getting
// index 2 vs 3 wrong is not a crash -- it is a screen of white comments, or
// comments coloured by a timestamp -- so it gets a node check against real
// payload shapes.
import assert from 'node:assert/strict';
import { parseBiliXml, parseDandan, parseAny, intToHex, throttle, block } from '../src/danmaku/parse.js';

// --- bilibili XML -----------------------------------------------------------
// Verbatim shape of a real list.so dump:
//   p="time,mode,fontsize,color,ctime,pool,uidhash,rowid,weight"
const xml = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver>
<d p="9.02100,1,25,16777215,1516810212,0,f5b70f3d,4210753616,10">你指尖跃动的电光</d>
<d p="28.97300,4,25,13369344,1502719844,0,a77032eb,3697030042,10">底部弹幕</d>
<d p="30.5,5,25,16646914,1502719844,0,a77032eb,3697030043,10">顶部弹幕</d>
<d p="40,6,25,255,1502719844,0,a,1,10">逆向</d>
<d p="50,7,25,255,1502719844,0,a,2,10">[1,2,"高级弹幕"]</d>
<d p="60,1,25,16777215,1,0,a,3,10">  &amp;转义&lt;ok&gt;  </d>
<d p="70,1,25,16777215,1,0,a,4,10">   </d></i>`;

const b = parseBiliXml(xml);
assert.equal(b.length, 5, 'mode 7 (positioned) and the blank one are dropped, the other five kept');
assert.deepEqual(b[0], { time: 9.021, mode: 'rtl', color: '#ffffff', text: '你指尖跃动的电光' });
assert.equal(b[1].mode, 'bottom', 'mode 4 = bottom');
assert.equal(b[2].mode, 'top', 'mode 5 = top');
assert.equal(b[2].color, '#fe0302', 'colour is field 3 in bilibili XML, not field 2');
assert.equal(b[3].mode, 'ltr', 'mode 6 = reverse');
assert.equal(b[4].text, '&转义<ok>', 'entities decoded, whitespace trimmed');

// --- dandanplay JSON --------------------------------------------------------
// Same idea, one field shorter: p="time,mode,color,uid". Colour has MOVED.
const dd = {
  count: 3,
  comments: [
    { cid: 1, p: '12.5,1,16777215,9527', m: '滚动' },
    { cid: 2, p: '20,5,16646914,9527', m: '顶部' },
    { cid: 3, p: [30, 4, 255, 1], m: '数组形式的 p' },   // some proxies pre-split it
    { cid: 4, p: '40,8,255,1', m: '代码弹幕' },           // mode 8: no renderer
    { cid: 5, p: '50,1,255,1', m: '   ' },                // empty after trim
  ],
};
const d = parseDandan(dd);
assert.equal(d.length, 3);
assert.deepEqual(d[0], { time: 12.5, mode: 'rtl', color: '#ffffff', text: '滚动' });
assert.equal(d[1].color, '#fe0302', 'colour is field 2 in dandanplay JSON');
assert.deepEqual(d[2], { time: 30, mode: 'bottom', color: '#0000ff', text: '数组形式的 p' });
assert.deepEqual(parseDandan([{ p: '1,1,0,0', m: 'bare array envelope' }]).length, 1);
assert.deepEqual(parseDandan(null), [], 'garbage in, empty list out -- never throws');

// Hand the SAME field list to both parsers: they must disagree about the
// colour, because bilibili puts font size where dandanplay puts colour. This is
// the whole reason there are two parsers, and the assertion that would fail if
// someone ever "simplified" them into one.
const fields = '0,1,25,255';   // bilibili: size 25, colour 255 | dandanplay: colour 25
assert.equal(parseBiliXml(`<d p="${fields},0,0,a,1,10">x</d>`)[0].color, '#0000ff', 'bilibili reads colour at index 3');
assert.equal(parseDandan([{ p: fields, m: 'x' }])[0].color, '#000019', 'dandanplay reads colour at index 2');

// --- sniffing ---------------------------------------------------------------
assert.equal(parseAny(xml).length, 5, 'XML sniffed by its leading <');
assert.equal(parseAny(JSON.stringify(dd)).length, 3, 'JSON sniffed by parse');
assert.deepEqual(parseAny('not danmaku at all'), [], 'unparseable -> empty, not an exception');

// --- colours ----------------------------------------------------------------
assert.equal(intToHex(16777215), '#ffffff');
assert.equal(intToHex(0), '#000000', 'black is padded to six digits, not "#0"');
assert.equal(intToHex(255), '#0000ff');
assert.equal(intToHex(-1), '#ffffff', 'out of range falls back to white');
assert.equal(intToHex('nope'), '#ffffff');

// --- density throttle -------------------------------------------------------
const many = Array.from({ length: 100 }, (_, i) => ({ time: i / 10, mode: 'rtl', color: '#fff', text: `c${i}` }));
assert.equal(throttle(many, 3).length, 30, '3 per second over 10 seconds');
assert.equal(throttle(many, 3)[0].text, 'c0', 'keeps the earliest in each second');
assert.equal(throttle(many, 0).length, 100, '0 = no cap');
assert.equal(throttle(many, -1).length, 100);

// --- blocklist --------------------------------------------------------------
const list = [{ text: '前方高能' }, { text: 'HIGH ENERGY' }, { text: '普通弹幕' }, { text: '2333333' }];
assert.equal(block(list, ['高能']).length, 3, 'plain substring');
assert.equal(block(list, ['high']).length, 3, 'substring match is case-insensitive');
assert.equal(block(list, ['/^\\d+$/']).length, 3, '/regex/ entries are compiled');
assert.equal(block(list, ['/(/']).length, 4, 'an invalid regex degrades to a plain substring instead of throwing');
assert.equal(block(list, []).length, 4);
assert.equal(block(list, null).length, 4);

console.log('test-danmaku: ok');
