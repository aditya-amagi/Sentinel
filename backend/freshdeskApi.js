// freshdeskApi.js — Freshdesk API client
// Real mode: set FRESHDESK_DOMAIN + FRESHDESK_API_KEY in .env
// Mock mode: returns deterministic ticket IDs (10001, 10002…) when env vars absent

'use strict';

const axios = require('axios');

const DOMAIN  = process.env.FRESHDESK_DOMAIN  || '';
const API_KEY = process.env.FRESHDESK_API_KEY || '';

// Deterministic counter for mock mode — persists for the lifetime of the process
let _mockSeq = 10001;

function getClient() {
  if (!DOMAIN || !API_KEY) return null;
  return axios.create({
    baseURL: `https://${DOMAIN}/api/v2`,
    auth:    { username: API_KEY, password: 'X' },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

async function createTicket(payload) {
  const client = getClient();

  if (!client) {
    // DEMO / MOCK MODE
    let tid;
    try {
      const demo = require('./demoData');
      tid = demo.nextDemoTicketId();
    } catch {
      tid = _mockSeq++;
    }

    console.log(`[freshdesk] MOCK — ticket ${tid}: ${payload.subject}`);
    return {
      freshdesk_id:    tid,
      ticket_number:   `INC-${tid}`,
      ticket_url:      `https://freshdesk.test/ticket/${tid}`,
      subject:         payload.subject,
      requester_email: payload.email,
      mock:            true,
    };
  }

  // Real Freshdesk
  const body = {
    email:       payload.email,
    subject:     payload.subject,
    description: payload.description,

    priority:    payload.priority || 2,
    status:      payload.status   || 2,

    type:     process.env.FRESHDESK_TYPE     || 'Issue',
    group_id: Number(process.env.FRESHDESK_GROUP_ID),

    cc_emails: Array.isArray(payload.cc_emails) ? payload.cc_emails : [],

    custom_fields: {
      cf_products:           'Amagi CLOUDPORT',
      cf_impact:             'Critical / P2',
      cf_impacted_customer:  'Amagi Media Labs Pvt. Ltd.',
    },
  };

  /*
  // Dynamic custom fields (commented out — using fixed values above)
  const cf = {};
  if (payload.custom_fields?.customer_name)   cf.cf_customer_name   = payload.custom_fields.customer_name;
  if (payload.custom_fields?.product_version) cf.cf_product_version = payload.custom_fields.product_version;
  if (Object.keys(cf).length) body.custom_fields = cf;
  */

  try {
    const res = await client.post('/tickets', body);
    const t   = res.data;
    return {
      freshdesk_id:    t.id,
      ticket_number:   `INC-${t.id}`,
      ticket_url:      `https://${DOMAIN}/helpdesk/tickets/${t.id}`,
      subject:         t.subject,
      requester_email: t.email || payload.email,
      mock:            false,
    };
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[freshdesk] createTicket failed:', detail);
    throw new Error(`Freshdesk API error: ${JSON.stringify(detail)}`);
  }
}

async function getTicket(freshdesk_id) {
  const client = getClient();
  if (!client) return { id: freshdesk_id, mock: true };
  const res = await client.get(`/tickets/${freshdesk_id}`);
  return res.data;
}

module.exports = { createTicket, getTicket, isMock: () => !DOMAIN || !API_KEY };
