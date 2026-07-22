import { connect } from 'cloudflare:sockets';

const CRLF = '\r\n';

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function cleanEmail(value) {
  const raw = cleanHeader(value);
  const match = raw.match(/<([^<>@\s]+@[^<>\s]+)>/) || raw.match(/([^<>,;\s]+@[^<>,;\s]+)/);
  return match ? match[1].trim() : raw;
}

function normalizeAddressList(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeAddressList);
  return String(value || '')
    .split(/[;,]/)
    .map(cleanEmail)
    .filter(Boolean);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function toBase64(value) {
  return bytesToBase64(new TextEncoder().encode(String(value || '')));
}

function foldBase64(value) {
  return String(value || '').replace(/.{1,76}/g, '$&' + CRLF).trimEnd();
}

function encodeHeader(value) {
  const text = cleanHeader(value);
  if (!text) return '';
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${toBase64(text)}?=`;
}

function formatFrom(payload, smtpConfig) {
  const fromEmail = cleanEmail(payload.from || smtpConfig.from || smtpConfig.user);
  const fromName = cleanHeader(payload.fromName);
  if (!fromName) return fromEmail;
  return `${encodeHeader(fromName)} <${fromEmail}>`;
}

function buildMimeMessage(payload, smtpConfig) {
  const html = String(payload.html || '');
  const text = String(payload.text || '');
  const hasHtml = html.trim().length > 0;
  const hasText = text.trim().length > 0;
  const boundary = `freemail-${crypto.randomUUID()}`;
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const replyTo = cleanHeader(payload.replyTo || payload.reply_to || '');

  const headers = [
    `From: ${formatFrom(payload, smtpConfig)}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(payload.subject || '(no subject)')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${cleanEmail(smtpConfig.from || smtpConfig.user).split('@')[1] || 'freemail.local'}>`,
    'MIME-Version: 1.0'
  ];

  if (payload.headers && typeof payload.headers === 'object') {
    for (const [key, value] of Object.entries(payload.headers)) {
      const headerName = cleanHeader(key);
      if (/^[A-Za-z0-9-]+$/.test(headerName)) {
        headers.push(`${headerName}: ${cleanHeader(value)}`);
      }
    }
  }

  if (hasHtml && hasText) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      foldBase64(toBase64(text)),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      foldBase64(toBase64(html)),
      `--${boundary}--`,
      ''
    ].join(CRLF);
  }

  const body = hasHtml ? html : text;
  headers.push(`Content-Type: ${hasHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`);
  headers.push('Content-Transfer-Encoding: base64');
  return [...headers, '', foldBase64(toBase64(body)), ''].join(CRLF);
}

function dotStuff(message) {
  return String(message || '').replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

function assertSmtpConfig(config) {
  if (!isSmtpConfigured(config)) {
    throw new Error('未配置 SMTP 发信服务');
  }
}

export function isSmtpConfigured(config = {}) {
  return Boolean(config.host && config.port && config.user && config.pass);
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = '';
  }

  async write(line) {
    await this.writer.write(this.encoder.encode(line));
  }

  async command(line, expected = [250]) {
    await this.write(`${line}${CRLF}`);
    const response = await this.readResponse();
    if (!expected.includes(response.code)) {
      throw new Error(`SMTP ${line.split(/\s+/)[0]} failed: ${response.text}`);
    }
    return response;
  }

  async readResponse() {
    const lines = [];
    while (true) {
      const index = this.buffer.indexOf(CRLF);
      if (index === -1) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error('SMTP connection closed');
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (match && match[2] === ' ') {
        return {
          code: Number(match[1]),
          text: lines.join('\n')
        };
      }
    }
  }

  detach() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  async close() {
    try { await this.command('QUIT', [221]); } catch (_) { }
    try { await this.writer.close(); } catch (_) { }
    try { await this.socket.close(); } catch (_) { }
  }
}

async function openSmtpClient(config) {
  const port = Number(config.port || 587);
  let socket = connect(
    { hostname: config.host, port },
    { secureTransport: port === 465 ? 'on' : 'starttls' }
  );
  await socket.opened;
  let client = new SmtpClient(socket);
  await client.readResponse();

  const heloName = cleanHeader(config.helo || 'freemail.123kele.com') || 'freemail.local';
  await client.command(`EHLO ${heloName}`);

  if (port !== 465) {
    await client.command('STARTTLS', [220]);
    client.detach();
    socket = socket.startTls();
    await socket.opened;
    client = new SmtpClient(socket);
    await client.command(`EHLO ${heloName}`);
  }

  await client.command(`AUTH PLAIN ${toBase64(`\u0000${config.user}\u0000${config.pass}`)}`, [235]);
  return client;
}

export async function sendEmailWithSmtp(config, payload) {
  assertSmtpConfig(config);
  if (payload?.scheduledAt) {
    throw new Error('SMTP 发信暂不支持计划发送');
  }
  if (payload?.attachments?.length) {
    throw new Error('SMTP 发信暂不支持附件');
  }

  const recipients = [
    ...normalizeAddressList(payload.to),
    ...normalizeAddressList(payload.cc),
    ...normalizeAddressList(payload.bcc)
  ];
  if (!recipients.length) throw new Error('缺少收件人地址');

  const envelopeFrom = cleanEmail(config.envelopeFrom || config.from || config.user);
  const message = buildMimeMessage(payload, config);
  const client = await openSmtpClient(config);
  try {
    await client.command(`MAIL FROM:<${envelopeFrom}>`);
    for (const recipient of recipients) {
      await client.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await client.command('DATA', [354]);
    await client.write(`${dotStuff(message)}${CRLF}.${CRLF}`);
    const dataResponse = await client.readResponse();
    if (dataResponse.code !== 250) {
      throw new Error(`SMTP DATA failed: ${dataResponse.text}`);
    }
  } finally {
    await client.close();
  }

  return {
    id: `smtp-${crypto.randomUUID()}`,
    provider: 'smtp'
  };
}

export async function sendBatchWithSmtp(config, payloads) {
  const results = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    results.push(await sendEmailWithSmtp(config, payload));
  }
  return results;
}
