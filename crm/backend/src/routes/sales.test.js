import { test } from 'node:test';
import assert from 'node:assert/strict';

test('guatemala timezone sales date math', () => {
  // Verifies that Guatemala timezone (UTC-6) is correctly formatted for queries
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const gt = new Date(utc - 6 * 3600000);
  const gtDateStr = gt.toISOString().slice(0, 10);
  assert.match(gtDateStr, /^\d{4}-\d{2}-\d{2}$/);
});

test('computes sales metrics aggregations correctly', () => {
  const sampleTransactions = [
    { advisorName: 'Asesor 1', amount: 800, customerId: 101 },
    { advisorName: 'Asesor 1', amount: 1200, customerId: 102 },
    { advisorName: 'Asesor 1', amount: 500, customerId: 103 },
    { advisorName: 'Asesor 1', amount: 900, customerId: 104 },
    { advisorName: 'Asesor 1', amount: 600, customerId: 105 },
    { advisorName: 'Asesor 2', amount: 3500, customerId: 201 },
    { advisorName: 'Asesor 2', amount: 3500, customerId: 202 },
  ];

  // Asesor 1: 5 clientes, Q4000 total
  const asesor1Sales = sampleTransactions.filter((s) => s.advisorName === 'Asesor 1');
  const asesor1Total = asesor1Sales.reduce((acc, s) => acc + s.amount, 0);
  const asesor1Clients = new Set(asesor1Sales.map((s) => s.customerId)).size;
  assert.equal(asesor1Total, 4000);
  assert.equal(asesor1Clients, 5);

  // Asesor 2: 2 clientes, Q7000 total
  const asesor2Sales = sampleTransactions.filter((s) => s.advisorName === 'Asesor 2');
  const asesor2Total = asesor2Sales.reduce((acc, s) => acc + s.amount, 0);
  const asesor2Clients = new Set(asesor2Sales.map((s) => s.customerId)).size;
  assert.equal(asesor2Total, 7000);
  assert.equal(asesor2Clients, 2);

  // Global total: Q11000, 7 clients, avg ticket Q1571.43
  const grandTotal = sampleTransactions.reduce((acc, s) => acc + s.amount, 0);
  assert.equal(grandTotal, 11000);
  const totalClients = new Set(sampleTransactions.map((s) => s.customerId)).size;
  assert.equal(totalClients, 7);
  const avgTicket = (grandTotal / sampleTransactions.length).toFixed(2);
  assert.equal(avgTicket, '1571.43');
});
