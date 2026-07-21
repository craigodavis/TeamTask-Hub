#!/bin/bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5N2I3OGZjZC03M2VmLTQ5YjktOWJkMC0wZjE3ZmQ5MTgwOTIiLCJjb21wYW55SWQiOiI4ZDJkZjQ5OC1iNWMwLTRmNzMtOTRjZC0zMjM5NTYwMzYxMTMiLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODA5MzYwMDEsImV4cCI6MTc4ODcxMjAwMX0.NRgrpWkfxtEffSOKb9OZ4EJg64Tzt1J9kN1lzB-WXow"
BASE="https://team.kindredvineyards.com/api"

# Get pending receipts and find Chef Store
curl -s "$BASE/receipts?status=pending" \
  -H "Authorization: Bearer $TOKEN" \
  > /Users/kindred/Dev/teamHub/prod-receipts.json 2>&1

# Parse
node -e "
  const data = JSON.parse(require('fs').readFileSync('/Users/kindred/Dev/teamHub/prod-receipts.json','utf8'));
  const cs = Array.isArray(data) ? data.filter(r => r.vendor === 'Chef Store') : [];
  console.log('Chef Store pending receipts:', cs.length);
  if (cs.length > 0) {
    const r = cs[0];
    console.log('First receipt:', JSON.stringify({
      id: r.id,
      order_number: r.order_number,
      item_count: r.item_count,
      uncategorized_count: r.uncategorized_count,
      status: r.status,
      descriptions: r.descriptions?.slice(0, 100)
    }, null, 2));
    // Fetch the detail for this receipt
    process.stdout.write('RECEIPT_ID=' + r.id + '\n');
  }
" > /Users/kindred/Dev/teamHub/check-out.txt 2>&1
cat /Users/kindred/Dev/teamHub/check-out.txt
