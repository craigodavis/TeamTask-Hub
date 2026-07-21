#!/bin/bash
cd /Users/kindred/Dev/teamHub/server
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5N2I3OGZjZC03M2VmLTQ5YjktOWJkMC0wZjE3ZmQ5MTgwOTIiLCJjb21wYW55SWQiOiI4ZDJkZjQ5OC1iNWMwLTRmNzMtOTRjZC0zMjM5NTYwMzYxMTMiLCJyb2xlIjoib3duZXIiLCJpYXQiOjE3ODA5MzYwMDEsImV4cCI6MTc4ODcxMjAwMX0.NRgrpWkfxtEffSOKb9OZ4EJg64Tzt1J9kN1lzB-WXow"
node scripts/import-chefstore-csv.js \
  "/Users/kindred/Downloads/CS-272129.xlsx - Sheet1.csv" \
  "$TOKEN" > /Users/kindred/Dev/teamHub/import-result.txt 2>&1
echo "Exit: $?" >> /Users/kindred/Dev/teamHub/import-result.txt
