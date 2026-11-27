'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * UI refresh: minimal-by-whitespace, unified icon language, new app icon.
 *
 * Three things drove this pass:
 *   - emoji were used as icons (tabs, speaker, dictation entry). They render
 *     differently on every ROM, carry their own colours that fight the accent,
 *     and cannot follow the theme.
 *   - every block carried a border AND a shadow, so hierarchy came from
 *     outlines and the screen read as a stack of boxes.
 *   - the study card reserved 260px, leaving a large dead zone on a one-word
 *     front.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const CSS = R('app/src/main/assets/style.css');
const GEN = R('tools/gen-icons.js');
const ADAPTIVE = R('app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');

/* -------------------------------------------------------------- icon system */

test('ui: navigation and actions use inline SVG, not emoji', () => {
  assert.ok(/var ICONS = \{/.test(APP), 'a shared icon set must exist');
  ['home', 'book', 'data', 'settings', 'speak'].forEach(k => {
    assert.ok(new RegExp(k + ':').test(APP), 'missing icon: ' + k);
  });
  // The tab bar used 🏠📖📊⚙️.
  assert.ok(!/['"](🏠|📖|📊|⚙️)['"]/.test(APP), 'no emoji may remain as a tab icon');
  // Pronunciation controls used 🔊.
  assert.ok(!/'🔊/.test(APP), 'the speaker must be an SVG');
});

test('ui: SVG icons inherit the theme colour', () => {
  assert.ok(/stroke="currentColor"/.test(APP), 'icons must take the surrounding colour');
  assert.ok(/\.tabs button \.ico svg\{/.test(CSS), 'tab icons need explicit sizing');
  assert.ok(/\.speak svg\{width:20px/.test(CSS), 'a speaker SVG without a size renders as an empty circle');
});

test('ui: an empty state or button glyph always has a size rule', () => {
  // Guards the class of bug where swapping an emoji for an SVG collapses it.
  assert.ok(/\.btn \.ico svg\{width:18px/.test(CSS), 'button icons need a size');
  assert.ok(/\.empty \.big svg\{/.test(CSS), 'empty-state icons need a size');
});

/* ------------------------------------------------------------ visual style */

test('ui: cards no longer stack border and shadow', () => {
  const card = /^\.card\{[\s\S]*?\n\}/m.exec(CSS);
  assert.ok(card, 'the card rule must exist');
  assert.ok(/border:0/.test(card[0]), 'a border plus a shadow read as a box outline');
  assert.ok(/0 1px 2px/.test(card[0]), 'the remaining shadow must be very light');
});

test('ui: the home summary is typographic, not three boxes', () => {
  const stat = /^\.stat\{[^}]*\}/m.exec(CSS);
  assert.ok(stat, 'the stat rule must exist');
  assert.ok(!/border/.test(stat[0]), 'the figures should not sit in bordered boxes');
  assert.ok(!/background/.test(stat[0]), 'no panel behind each figure');
  assert.ok(/26px/.test(CSS), 'the figures carry the hierarchy through size');
});

test('ui: the filter strip is one scrollable row', () => {
  assert.ok(/\.chips\.scroll\{/.test(CSS), 'a scroll variant must exist');
  assert.ok(/flex-wrap:nowrap/.test(CSS), 'six scopes wrapped and left an orphan chip');
  assert.ok(/overflow-x:auto/.test(CSS));
  assert.ok(/chips scroll/.test(APP), 'the home filters must use it');
});

test('ui: the study card sizes to its content', () => {
  const card = /^\.study-card\{[\s\S]*?\n\}/m.exec(CSS);
  assert.ok(card, 'the study card rule must exist');
  assert.ok(!/min-height/.test(card[0]),
    'a fixed minimum left a dead zone under a one-word front');
});

/* ------------------------------------------------------------- app icon */

test('icon: an adaptive icon is used so the launcher owns the mask', () => {
  assert.ok(/<adaptive-icon/.test(ADAPTIVE), 'must be adaptive, not a pre-rounded bitmap');
  assert.ok(/ic_launcher_foreground/.test(ADAPTIVE), 'artwork is a separate layer');
  assert.ok(/ic_launcher_background/.test(ADAPTIVE), 'background is its own layer');
  assert.ok(/<monochrome/.test(ADAPTIVE), 'Android 13 themed icons need a monochrome layer');
});

test('icon: the artwork is the M with a pen', () => {
  assert.ok(/two stems plus two diagonals/.test(GEN), 'the M must be drawn geometrically');
  // The app is a dictation trainer, so the second mark is a pen rather than a
  // generic sound wave. A third element would turn to mush at 48dp.
  assert.ok(/Pen: diagonal body with a nib/.test(GEN), 'the pen identifies dictation');
  assert.ok(/nib/.test(GEN), 'a pen needs a tapered nib to be recognisable');
  assert.ok(/glyphAt/.test(GEN), 'shapes are sampled per pixel, not scaled bitmaps');
  assert.ok(/SS = 4/.test(GEN), 'supersampling keeps small sizes clean');
});

test('icon: all densities are generated, including the adaptive layers', () => {
  ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'].forEach(d => {
    const dir = path.resolve(__dirname, '../app/src/main/res', d);
    assert.ok(fs.existsSync(path.join(dir, 'ic_launcher.png')), d + ' legacy icon missing');
    assert.ok(fs.existsSync(path.join(dir, 'ic_launcher_foreground.png')), d + ' foreground missing');
    // The adaptive background is a solid brand fill.
    assert.ok(fs.existsSync(path.join(dir, 'ic_launcher_background.png')), d + ' background missing');
  });
});

test('icon: the generator draws analytically, so every size stays crisp', () => {
  assert.ok(/function drawForeground/.test(GEN), 'foreground must be drawn in code');
  assert.ok(/distToSeg/.test(GEN), 'geometry is computed per pixel, not scaled from one bitmap');
  assert.ok(/BRAND/.test(GEN), 'the brand colour must be shared, not hard-coded per call site');
});
