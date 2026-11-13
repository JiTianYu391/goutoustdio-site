import nodemailer from "nodemailer";

const e = process.env;
let tx = null;
if (e.MAIL_SMTP_HOST) {
  tx = nodemailer.createTransport({
    host: e.MAIL_SMTP_HOST,
    port: Number(e.MAIL_SMTP_PORT) || 465,
    secure: e.MAIL_SMTP_SECURE !== "false",
    auth: { user: e.MAIL_SMTP_USER, pass: e.MAIL_SMTP_PASS },
  });
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function sendMail(to, subject, text, link) {
  if (!tx) { console.warn("[mail] SMTP 未配置，邮件未发送：", subject, link); return false; }
  await tx.sendMail({
    from: e.MAIL_FROM || e.MAIL_SMTP_USER, to, subject, text: `${text}\n\n${link}`,
    html: `<p>${esc(text)}</p><p><a href="${esc(link)}">${esc(link)}</a></p><p style="color:#888">如果这不是你本人的操作，请忽略此邮件。</p>`,
  });
  return true;
}

// 通用邮件：paragraphs 为纯文本段落数组；可选按钮链接与退订链接
export async function sendNotice(to, subject, paragraphs, { link, linkText, unsubscribe } = {}) {
  if (!tx) { console.warn("[mail] SMTP 未配置，邮件未发送：", subject, link || ""); return false; }
  const text = paragraphs.join("\n\n") + (link ? `\n\n${linkText || "打开链接"}：${link}` : "") + (unsubscribe ? `\n\n退订：${unsubscribe}` : "");
  const html = `<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:560px;margin:auto;color:#1f2328;line-height:1.6">
    <p style="font-weight:700;font-size:16px">GoutouStdio</p>
    ${paragraphs.map((p) => `<p style="white-space:pre-wrap">${esc(p)}</p>`).join("")}
    ${link ? `<p><a href="${esc(link)}" style="display:inline-block;padding:8px 16px;background:#4b3fd6;color:#fff;border-radius:6px;text-decoration:none">${esc(linkText || "打开链接")}</a></p>` : ""}
    <hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0">
    <p style="color:#656d76;font-size:12px">这封邮件由 GoutouStdio 自动发送。${unsubscribe ? `<a href="${esc(unsubscribe)}" style="color:#656d76">退订此类邮件</a>` : "如果这不是你本人的操作，请尽快修改密码。"}</p></div>`;
  await tx.sendMail({ from: e.MAIL_FROM || e.MAIL_SMTP_USER, to, subject, text, html,
    headers: unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>` } : undefined });
  return true;
}

