#!/bin/bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5N2I3OGZjZC03M2VmLTQ5YjktOWJkMC0wZjE3ZmQ5MTgwOTIiLCJjb21wYW55SWQiOiI4ZDJkZjQ5OC1iNWMwLTRmNzMtOTRjZC0zMjM5NTYwMzYxMTMiLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODA5MzYwMDEsImV4cCI6MTc4ODcxMjAwMX0.NRgrpWkfxtEffSOKb9OZ4EJg64Tzt1J9kN1lzB-WXow"
BASE="http://localhost:3001/api"

# Get pending Chef Store receipts
curl -s "$BASE/receipts?status=pending" \
  -H "Authorization: Bearer $TOKEN" | \
  node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const cs = data.filter(r => r.vendor === 'Chef Store');
    console.log('Chef Store pending receipts:', cs.length);
    if (cs.length > 0) {
      const r = cs[0];
      console.log('First receipt:', JSON.stringify({id: r.id, order_number: r.order_number, item_count: r.item_count, uncategorized_count: r.uncategorized_count, status: r.status}, null, 2));
    }
  " > /Users/kindred/Dev/teamHub/check-out.txt 2>&1
echo "exit:$?" >> /Users/kindred/Dev/teamHub/check-out.txt
