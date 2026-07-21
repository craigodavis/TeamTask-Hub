#!/bin/bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5N2I3OGZjZC03M2VmLTQ5YjktOWJkMC0wZjE3ZmQ5MTgwOTIiLCJjb21wYW55SWQiOiI4ZDJkZjQ5OC1iNWMwLTRmNzMtOTRjZC0zMjM5NTYwMzYxMTMiLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODA5MzYwMDEsImV4cCI6MTc4ODcxMjAwMX0.NRgrpWkfxtEffSOKb9OZ4EJg64Tzt1J9kN1lzB-WXow"
BASE="https://team.kindredvineyards.com/api"
ID="b5470ad7-3e16-43cc-9ea7-168114285c82"

curl -s "$BASE/receipts/$ID" \
  -H "Authorization: Bearer $TOKEN" | \
  node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('Receipt:', d.order_number, d.vendor, d.status);
    console.log('Items:');
    for (const i of d.items) {
      console.log(' -', i.description, '| account:', i.account_name || '(none)', '| status:', i.item_status);
    }
  " > /Users/kindred/Dev/teamHub/detail-out.txt 2>&1
cat /Users/kindred/Dev/teamHub/detail-out.txt
