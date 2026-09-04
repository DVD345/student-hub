// Збирач розкладу з UniHub (unihub.kart.edu.ua).
//
// UniHub — застосунок на Blazor Server: сторінка спілкується із сервером
// по WebSocket і отримує вже готову розмітку. Жодної адреси, яка віддає
// розклад даними, там немає — перевірено перебором API, експортів та
// серверного рендерингу. Тому єдиний спосіб — відкрити сторінку у
// справжньому браузері й пройти фільтри так, як це робить людина.
//
// Запускається вручну (Actions → Run workflow), а не за розкладом:
// розклад змінюється раз на семестр, ганяти щоночі немає сенсу.
//
// Локально:  node tools/scrape-schedule.mjs --limit 3
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://unihub.kart.edu.ua/';
const OUT = 'schedule/unihub.json';

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const LIMIT = limitAt !== -1 ? Number(args[limitAt + 1]) : Infinity;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Селектори шукаються за підписом поля, а не за позицією в DOM:
// підписи ("Факультет", "Курс") переживають зміну оформлення, порядок — ні.
// Усе робиться одним evaluate замість передавання елемента між викликами:
// так менше рухомих частин і немає залежності від того, як бібліотека
// серіалізує посилання на вузол.
async function options(page, label) {
  return page.evaluate((lbl) => {
    const sels = [...document.querySelectorAll('select')];
    const sel = sels.find((s) => {
      const near = s.closest('div');
      return near && near.textContent.trim().startsWith(lbl);
    });
    if (!sel) return null;
    return [...sel.options]
      .map((o) => ({ value: o.value, text: o.textContent.trim() }))
      .filter((o) => o.value !== '');
  }, label);
}

// Те, що зараз реально обране у полі. Раніше рік брався як останній
// варіант списку — і файл підписувався 2027-2028, хоча збирався розклад
// за 2026-2027, який стоїть за замовчуванням.
async function selected(page, label) {
  return page.evaluate((lbl) => {
    const sels = [...document.querySelectorAll('select')];
    const sel = sels.find((s) => {
      const near = s.closest('div');
      return near && near.textContent.trim().startsWith(lbl);
    });
    if (!sel || sel.selectedIndex < 0) return '';
    return sel.options[sel.selectedIndex].textContent.trim();
  }, label);
}

async function choose(page, label, value) {
  const ok = await page.evaluate(({ lbl, val }) => {
    const sels = [...document.querySelectorAll('select')];
    const sel = sels.find((s) => {
      const near = s.closest('div');
      return near && near.textContent.trim().startsWith(lbl);
    });
    if (!sel) return false;
    sel.value = val;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { lbl: label, val: value });
  if (!ok) throw new Error('Не знайдено поле "' + label + '"');
  // Blazor домальовує наступний крок каскаду через сервер — чекаємо на це.
  await page.waitForTimeout(900);
}

// Та сама функція, що перевірена на живій сторінці.
async function extractSchedule(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.schedule-day-card')].map((card) => {
      const day = clean((card.querySelector('.day-header') || {}).textContent);
      const lessons = [];
      card.querySelectorAll('.lesson-sub-item').forEach((sub) => {
        const title = sub.querySelector('.lesson-title');
        const num = clean(((title && title.querySelector('strong')) || {}).textContent).replace(/\.$/, '');
        const kind = clean(((title && title.querySelector('span')) || {}).textContent);
        const subject = title
          ? clean([...title.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '))
              .replace(/^[,\s]+|[,\s]+$/g, '')
          : '';
        const teacher = clean((sub.querySelector('.lesson-meta span') || {}).textContent);
        const badges = [...sub.querySelectorAll('.lesson-footer .footer-badge')].map((b) => clean(b.textContent));
        const time = badges.find((b) => /\d{1,2}:\d{2}/.test(b)) || '';
        const parity = badges.find((b) => /парний/i.test(b)) || '';
        lessons.push({ num, subject, kind, teacher, time, parity });
      });
      return { day, lessons };
    }).filter((d) => d.day);
  });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: 'uk-UA' });
  const report = { ok: 0, empty: 0, failed: 0, errors: [] };
  const groups = {};
  let meta = {};

  try {
    // Не networkidle: Blazor тримає WebSocket відкритим постійно, тож
    // "мережа затихла" тут не настає ніколи і чекання впиралося б у таймаут.
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Чекаємо, поки Blazor підніме канал і намалює фільтри: поява <select>
    // з реальними опціями — ознака, що канал уже працює.
    await page.waitForFunction(() => {
      const s = document.querySelectorAll('select');
      return s.length >= 4 && [...s].some((x) => x.options.length > 1);
    }, { timeout: 90000 });
    await page.waitForTimeout(2000);

    const years = await options(page, 'Навчальний рік');
    if (!years) throw new Error('Не знайдено полів фільтра — сторінка змінилася?');
    meta = {
      year: await selected(page, 'Навчальний рік'),
      semester: await selected(page, 'Семестр')
    };
    console.log('Рік: ' + meta.year + ', семестр: ' + meta.semester);

    const faculties = await options(page, 'Факультет') || [];
    console.log('Факультетів: ' + faculties.length);
    if (!faculties.length) throw new Error('Список факультетів порожній');

    let done = 0;
    outer:
    for (const faculty of faculties) {
      await choose(page, 'Факультет', faculty.value);
      const courses = await options(page, 'Курс') || [];
      for (const course of courses) {
        await choose(page, 'Курс', course.value);
        const groupList = await options(page, 'Група') || [];
        for (const g of groupList) {
          if (done >= LIMIT) break outer;
          done++;
          try {
            await choose(page, 'Група', g.value);
            await page.waitForTimeout(1200);
            const days = await extractSchedule(page);
            const lessonCount = days.reduce((n, d) => n + d.lessons.length, 0);
            if (!lessonCount) {
              report.empty++;
              console.log('— ' + g.text + ': порожньо');
              continue;
            }
            groups[g.text] = {
              id: g.value,
              faculty: faculty.text,
              course: course.text,
              days
            };
            report.ok++;
            console.log('✓ ' + g.text + ': ' + lessonCount + ' пар');
          } catch (e) {
            report.failed++;
            report.errors.push(g.text + ': ' + (e && e.message));
            console.log('✗ ' + g.text + ': ' + (e && e.message));
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (!report.ok) {
    // Порожній результат майже завжди означає, що сторінку перевіpстали і
    // селектори більше не збігаються. Краще впасти, ніж перезаписати
    // робочі дані порожнечею.
    console.error('\nЖодної групи не зібрано — імовірно, змінилася структура сторінки.');
    process.exit(1);
  }

  mkdirSync('schedule', { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    source: 'unihub.kart.edu.ua',
    builtAt: new Date().toISOString(),
    year: meta.year,
    semester: meta.semester,
    groups
  }, null, 1));

  console.log('\nЗібрано: ' + report.ok + ', порожніх: ' + report.empty + ', помилок: ' + report.failed);
  console.log('Записано у ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
