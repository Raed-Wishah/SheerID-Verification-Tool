import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CreditStore, PACKS, validTicket } from './store.mjs';

const page = readFileSync(new URL('./shop.html', import.meta.url), 'utf8');
const scenarios = new Map([
  ['eligible', 'مؤهّل في المحاكاة. السجل التدريبي يطابق شروط المثال.'],
  ['review', 'بانتظار المراجعة في المحاكاة. المثال يوضّح حالة تحتاج مراجعة بشرية.'],
  ['ineligible', 'غير مؤهّل في المحاكاة. السجل التدريبي لا يطابق شروط المثال.'],
]);
const commands = [
  { command: 'simulate', description: 'تشغيل تمرين محاكاة مقابل كريديت واحد' },
  { command: 'balance', description: 'عرض الرصيد التدريبي' },
  { command: 'buy', description: 'فتح صفحة شحن الرصيد التجريبي' },
];

function replyPage(response, status, content) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(page.replace('<!-- CHECKOUT -->', content));
}

function checkoutPage(response, ticket, status) {
  if (!status) {
    return replyPage(response, 404, `<section class="notice">
      <h2>رابط الشحن غير صالح أو انتهت صلاحيته</h2>
      <p>ارجع للبوت واستخدم <bdi>/buy</bdi> للحصول على رابط جديد.</p>
    </section>`);
  }

  const balance = `<div class="balance"><span>رصيدك الحالي</span><strong>${status.balance} كريديت</strong></div>`;
  if (status.credits !== null) {
    return replyPage(response, 200, `${balance}<section class="notice" role="status">
      <h2>تم الشحن بنجاح</h2>
      <p>انضاف ${status.credits} كريديت تجريبي لحسابك. ارجع للبوت واكتب <bdi>/simulate</bdi> لتشغّل تمرين.</p>
    </section>`);
  }

  const options = PACKS.map((credits, index) => `<label class="pack">
    <input type="radio" name="pack" value="${credits}"${index === 0 ? ' checked' : ''}>
    <strong>${credits} كريديت</strong>
  </label>`).join('');
  replyPage(response, 200, `${balance}<form method="post" action="/shop">
    <input type="hidden" name="ticket" value="${ticket}">
    <fieldset>
      <legend>اختار باقة تجريبية</legend>
      <div class="packs">${options}</div>
    </fieldset>
    <button type="submit">أضف الكريديت لحسابي</button>
    <small>الشحن في النسخة التدريبية مجاني.</small>
  </form>`);
}

async function readForm(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    request.resume();
    return null;
  }

  let body = '';
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024) {
      request.resume();
      return null;
    }
    body += chunk.toString('ascii');
  }
  return new URLSearchParams(body);
}

export function createShop(store) {
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/shop') {
        return replyPage(response, 404, '<p>افتح صفحة الشحن بالأمر <bdi>/buy</bdi> من البوت.</p>');
      }

      if (request.method === 'GET') {
        const ticket = url.searchParams.get('ticket');
        return checkoutPage(response, ticket, store.shopStatus(ticket));
      }

      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        return replyPage(response, 405, '<p>افتح رابط الشحن من البوت.</p>');
      }

      const form = await readForm(request);
      const ticket = form?.get('ticket');
      const pack = PACKS.find((credits) => String(credits) === form?.get('pack'));
      if (!validTicket(ticket) || !pack) {
        return replyPage(response, 400, '<p>تعذّر قراءة طلب الشحن. ارجع لصفحة الشحن واختر باقة تجريبية.</p>');
      }

      return checkoutPage(response, ticket, store.redeem(ticket, pack));
    } catch {
      replyPage(response, 500, '<p>تعذّر إكمال الطلب. جرّب مرة ثانية بنفس رابط الشحن.</p>');
    }
  });
  return server;
}

export async function handleMessage(store, telegram, shopOrigin, message) {
  if (message?.chat?.type !== 'private' || !message.from || !message.text?.startsWith('/')) return;
  const userId = message.from.id;
  const [command, selectedScenario = 'eligible'] = message.text.trim().split(/\s+/);
  const reply = { chat_id: message.chat.id };

  switch (command.split('@')[0]) {
    case '/start':
      reply.text = 'أهلاً في مختبر التحقق. اشحن رصيد تدريبي من /buy، شوف رصيدك من /balance، وشغّل تمرين من /simulate.';
      break;
    case '/balance':
      reply.text = `رصيدك ${store.balance(userId)} كريديت تجريبي.`;
      break;
    case '/buy': {
      const url = new URL('/shop', shopOrigin);
      url.searchParams.set('ticket', store.issueTicket(userId));
      reply.text = 'اختار باقة تدريبية وبتنضاف الكريديت لحساب تيلجرام اللي طلب الرابط. الرابط صالح لـ 15 دقيقة.';
      reply.reply_markup = { inline_keyboard: [[{ text: 'افتح صفحة الشحن', url: url.href }]] };
      break;
    }
    case '/simulate': {
      if (!scenarios.has(selectedScenario)) {
        reply.text = 'اختار أحد التمارين: /simulate eligible أو /simulate review أو /simulate ineligible';
        break;
      }
      const result = store.runExercise(userId, message.message_id, selectedScenario);
      reply.text = result.completed
        ? `${scenarios.get(result.scenario)}\nرصيدك المتبقي ${result.balance} كريديت.`
        : 'ما في رصيد كافي لبدء التمرين. استخدم /buy لشحن كريديت تجريبي.';
      break;
    }
    default:
      reply.text = 'استخدم /start لعرض الأوامر.';
  }

  await telegram.call('sendMessage', reply);
}

class TelegramError extends Error {
  constructor(method, code, retryAfter) {
    super(`Telegram test API ${method} failed (${code})`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function createTelegramTestClient(token) {
  return {
    async call(method, body = {}) {
      let result;
      let response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/test/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
          redirect: 'error',
        });
        result = await response.json();
      } catch {
        throw new TelegramError(method, response?.status ?? 503);
      }

      if (!response.ok || !result.ok) {
        throw new TelegramError(method, result.error_code ?? response.status, result.parameters?.retry_after);
      }
      return result.result;
    },
  };
}

async function pollTelegram(telegram, store, shopOrigin) {
  let offset;
  for (;;) {
    try {
      const updates = await telegram.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        try {
          await handleMessage(store, telegram, shopOrigin, update.message);
        } catch (error) {
          if (!(error instanceof TelegramError) || ![400, 403].includes(error.code)) throw error;
          console.error(error.message);
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (!(error instanceof TelegramError) || (error.code !== 429 && error.code < 500)) throw error;
      console.error(error.message);
      await delay((error.retryAfter ?? 3) * 1000);
    }
  }
}

async function main() {
  const token = process.env.TELEGRAM_TEST_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Set TELEGRAM_TEST_BOT_TOKEN to the token from the Telegram test environment.');
  }

  const port = Number(process.env.LAB_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAB_PORT.');
  const shopOrigin = new URL(process.env.LAB_SHOP_ORIGIN ?? `http://127.0.0.1:${port}`);
  if (!['https:', 'http:'].includes(shopOrigin.protocol) || shopOrigin.href !== `${shopOrigin.origin}/`) {
    throw new Error('LAB_SHOP_ORIGIN must be an HTTP or HTTPS origin.');
  }

  const telegram = createTelegramTestClient(token);
  const bot = await telegram.call('getMe');
  await telegram.call('setMyCommands', { commands });
  const store = new CreditStore(fileURLToPath(new URL('./lab.sqlite', import.meta.url)));
  const server = createShop(store);

  try {
    await new Promise((listen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', listen);
    });
    console.log(`Telegram test bot @${bot.username} is running. Checkout: ${shopOrigin.origin}`);
    await pollTelegram(telegram, store, shopOrigin);
  } finally {
    server.close();
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
