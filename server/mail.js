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
