const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendOTP(phone) {
  const verification = await client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({ to: phone, channel: 'sms' });
  return verification.sid;
}

async function checkOTP(phone, code) {
  const result = await client.verify.v2
    .services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({ to: phone, code });
  return result.status === 'approved';
}

// Create a Twilio Proxy session so customer and provider never see each other's real numbers
async function createProxySession(jobId, customerPhone, providerPhone) {
  const session = await client.proxy.v1
    .services(process.env.TWILIO_PROXY_SERVICE_SID)
    .sessions.create({
      uniqueName: `job-${jobId}`,
      ttl: 7200, // 2-hour session
    });

  await Promise.all([
    client.proxy.v1
      .services(process.env.TWILIO_PROXY_SERVICE_SID)
      .sessions(session.sid)
      .participants.create({ identifier: customerPhone }),
    client.proxy.v1
      .services(process.env.TWILIO_PROXY_SERVICE_SID)
      .sessions(session.sid)
      .participants.create({ identifier: providerPhone }),
  ]);

  const participants = await client.proxy.v1
    .services(process.env.TWILIO_PROXY_SERVICE_SID)
    .sessions(session.sid)
    .participants.list();

  const customerParticipant = participants.find(p => p.identifier === customerPhone);
  const providerParticipant = participants.find(p => p.identifier === providerPhone);

  return {
    sessionSid: session.sid,
    customerProxyNumber: customerParticipant?.proxyIdentifier,
    providerProxyNumber: providerParticipant?.proxyIdentifier,
  };
}

async function closeProxySession(sessionSid) {
  await client.proxy.v1
    .services(process.env.TWILIO_PROXY_SERVICE_SID)
    .sessions(sessionSid)
    .update({ status: 'closed' });
}

async function sendSMS(to, body) {
  return client.messages.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER,
    body,
  });
}

module.exports = { sendOTP, checkOTP, createProxySession, closeProxySession, sendSMS };
