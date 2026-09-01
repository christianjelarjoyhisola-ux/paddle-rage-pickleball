const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminSource = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

function styleBlock(id) {
  const marker = `<style id="${id}">`;
  const start = adminSource.indexOf(marker);
  assert.ok(start >= 0, `${id} style block must exist`);
  const end = adminSource.indexOf('</style>', start);
  assert.ok(end > start, `${id} style block must be closed`);
  return {
    start,
    end: end + '</style>'.length,
    source: adminSource.slice(start, end),
  };
}

function sourceBetween(startMarker, endMarker) {
  const start = adminSource.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist`);
  const end = adminSource.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return adminSource.slice(start, end);
}

test('the deterministic light cascade is last and owns the admin shell', () => {
  const modern = styleBlock('admin-modern-refresh');
  const system = styleBlock('admin-system-refresh');
  const light = styleBlock('admin-premium-light-theme');
  const headEnd = adminSource.indexOf('</head>');

  assert.ok(modern.start < system.start, 'system workspace styles must follow the modern shell');
  assert.ok(system.end < light.start, 'the light cascade must follow every dark refresh block');
  assert.ok(light.end < headEnd, 'the light cascade must stay in the document head');
  assert.equal(
    adminSource.slice(light.end, headEnd).includes('<style'),
    false,
    'no later inline style block may silently override the final light cascade',
  );

  assert.match(
    light.source,
    /body\[data-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light;[\s\S]*?background-color:\s*#[0-9a-f]{6}\s*!important;/i,
  );
  assert.match(light.source, /body\[data-theme="light"\]\s+\.topnav\s*\{[\s\S]*?background:/i);
  assert.match(light.source, /body\[data-theme="light"\]\s+\.nav-brand\s*\{\s*color:\s*#[0-9a-f]{6}/i);
  assert.match(light.source, /body\[data-theme="light"\]\s+\.sidebar\s*\{[\s\S]*?background:/i);
  assert.match(light.source, /body\[data-theme="light"\]\s+\.main\s*\{\s*background:/i);
});

test('light mode covers shared surfaces, data tables, controls, dialogs, and notices', () => {
  const light = styleBlock('admin-premium-light-theme').source;

  assert.match(
    light,
    /body\[data-theme="light"\]\s+:is\([\s\S]{0,240}?\.panel[\s\S]{0,240}?\.tbl-wrap[\s\S]{0,240}?\.chart-card[\s\S]{0,240}?\)\s*\{[\s\S]*?background:/i,
  );
  assert.match(light, /body\[data-theme="light"\]\s+\.tbl-hd\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+th\s*\{[\s\S]*?color:[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+td\s*\{[\s\S]*?color:/i);
  assert.match(
    light,
    /body\[data-theme="light"\]\s+:is\([\s\S]{0,260}?\.fi[\s\S]{0,260}?\.filters input[\s\S]{0,260}?select\.fi[\s\S]{0,260}?textarea\.fi[\s\S]{0,260}?\)\s*\{[\s\S]*?color:[\s\S]*?background:/i,
  );
  assert.match(light, /body\[data-theme="light"\]\s+\.modal\s*\{[\s\S]*?color:[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.toast\s*\{[\s\S]*?color:[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.admin-boot-splash\s*\{[\s\S]*?background:/i);
});

test('light mode explicitly covers finance surfaces and desktop/mobile Insights', () => {
  const light = styleBlock('admin-premium-light-theme').source;

  assert.match(light, /body\[data-theme="light"\]\s+#maintFeePanel\.pa-card\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.pa-position\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.pa-bucket\s*\{[\s\S]*?background:/i);
  assert.match(
    light,
    /body\[data-theme="light"\]\s+#sec-remittances,\s*body\[data-theme="light"\]\s+\.rm-modal\s*\{[\s\S]*?--surface:\s*#[0-9a-f]{6};[\s\S]*?--text:\s*#[0-9a-f]{6};/i,
  );
  assert.match(light, /body\[data-theme="light"\]\s+#sec-remittances\s+\.rm-live-card\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+#sec-payments\s+\.fee-rule-panel\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.fee-rule-method\s*\{[\s\S]*?background:/i);

  assert.match(light, /body\[data-theme="light"\]\s+\.pr-insights\s*\{[\s\S]*?--insight-ink:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.pr-insights-hero\s*\{[\s\S]*?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+:is\([\s\S]{0,180}?\.pr-insights-kpis[\s\S]{0,180}?\.pr-insights-card[\s\S]{0,180}?\)\s*\{/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.pr-insights-mobile-detail[\s\S]{0,180}?background:/i);
  assert.match(light, /body\[data-theme="light"\]\s+:is\(\.pr-insights-cell,\s*\.pr-insights-mobile-cell\)\s*\{\s*color:/i);
  assert.match(light, /body\[data-theme="light"\]\s+\.pr-insights-mobile-scroll-shell::after\s*\{\s*background:/i);
});

test('dashboard charts use concrete valid colors in both themes', () => {
  const chartSource = sourceBetween(
    'function renderDashCharts(',
    '   BOOKINGS',
  );

  assert.match(chartSource, /const green\s*=\s*isDark\s*\?\s*'#[0-9a-f]{6}'\s*:\s*'#[0-9a-f]{6}'/i);
  assert.match(chartSource, /const yellow\s*=\s*isDark\s*\?\s*'#[0-9a-f]{6}'\s*:\s*'#[0-9a-f]{6}'/i);
  assert.match(chartSource, /const textColor\s*=\s*isDark\s*\?\s*'#[0-9a-f]{6}'\s*:\s*'#[0-9a-f]{6}'/i);
  assert.doesNotMatch(chartSource, /['"]var\(--/i, 'Canvas colors cannot be unresolved CSS variables');
  assert.match(chartSource, /backgroundColor:\s*green\s*\+\s*'33'/);
  assert.match(chartSource, /backgroundColor:\s*yellow\s*\+\s*'1a'/);
});

test('the theme control exposes its action and current state to assistive technology', () => {
  const button = adminSource.match(/<button\b(?=[^>]*\bid="themeBtn")[^>]*>/i)?.[0] || '';
  const themeFunctions = sourceBetween('function toggleTheme()', 'function showAdminBoot(');

  assert.match(button, /\baria-label="Switch to Light Mode"/i);
  assert.match(button, /\baria-pressed="true"/i);
  assert.match(
    themeFunctions,
    /(?:setAttribute\(\s*['"]aria-label['"]|\.ariaLabel\s*=)/,
    'the changing emoji must have an explicit action label',
  );
  assert.match(
    themeFunctions,
    /(?:setAttribute\(\s*['"]aria-pressed['"]|\.ariaPressed\s*=)/,
    'the control must expose its current toggle state',
  );
  assert.match(themeFunctions, /Switch to Light Mode[\s\S]*?Switch to Dark Mode/);
});

test('narrow finance layouts collapse before fixed-width content can overflow', () => {
  assert.match(
    adminSource,
    /@media\s*\(max-width:\s*(?:5[2-9]\d|6\d\d)px\)\s*\{[\s\S]{0,5200}?\.rm-adjustment-row\s*\{[^}]*grid-template-columns:\s*1fr/i,
  );
  assert.match(
    adminSource,
    /@media\s*\(max-width:\s*(?:4[8-9]\d|5\d\d|6\d\d)px\)\s*\{[\s\S]{0,3600}?\.fee-rule-controls\s*\{[^}]*grid-template-columns:\s*1fr/i,
  );
});
