#!/bin/bash
cd /Users/kindred/Dev/teamHub/server

# Start server with .env
node -r dotenv/config index.js > /Users/kindred/Dev/teamHub/server.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for it to be ready
for i in $(seq 1 20); do
  sleep 2
  STATUS=$(curl -s --max-time 3 http://localhost:3001/api/health 2>/dev/null)
  if echo "$STATUS" | grep -q "ok"; then
    echo "Server ready after ${i}x2s"
    break
  fi
done

# Give pool a moment to init connections
sleep 3

# Run the import
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5N2I3OGZjZC03M2VmLTQ5YjktOWJkMC0wZjE3ZmQ5MTgwOTIiLCJjb21wYW55SWQiOiI4ZDJkZjQ5OC1iNWMwLTRmNzMtOTRjZC0zMjM5NTYwMzYxMTMiLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODA5MzYwMDEsImV4cCI6MTc4ODcxMjAwMX0.NRgrpWkfxtEffSOKb9OZ4EJg64Tzt1J9kN1lzB-WXow"
node scripts/import-chefstore-csv.js \
  "/Users/kindred/Downloads/CS-272129.xlsx - Sheet1.csv" \
  "$TOKEN" > /Users/kindred/Dev/teamHub/import-result.txt 2>&1
echo "Import exit: $?" >> /Users/kindred/Dev/teamHub/import-result.txt

kill $SERVER_PID 2>/dev/null
echo "done" >> /Users/kindred/Dev/teamHub/import-result.txt
