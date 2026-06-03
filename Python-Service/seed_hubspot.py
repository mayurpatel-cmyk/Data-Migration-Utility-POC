import httpx
import asyncio

# =========================================================
# CONFIGURATION BLOCK
# =========================================================
# 🟢 FIXED: The token is now properly assigned to the variable!
HUBSPOT_ACCESS_TOKEN = "CKev88ToMxITQlNQMl8kQEwrAgYACAkIDhIrARjB47x1IP-23E4oxK3AEzIUAZ3hYisx-Sh6cBrZMbs-x2oeDrM6JkJTUDJfJEBMKwIZAAgZBigBAQEBRTsBEjABAQE6AQEBAQElAQMBQhSKt2YlH68pwsDHNEnl-UF4OQoT7UoDbmEyUgBaAGAAaKqQryxwAXgA"


async def seed_bulk_contacts():
    # Strip any accidental hidden spaces or quotes
    token = HUBSPOT_ACCESS_TOKEN.strip().replace('"', '').replace("'", "")

    if token == "PASTE_YOUR_COPIED_TOKEN_HERE" or not token:
        print("❌ Error: Please paste your active hubspot_token string into the variable first.")
        return

    print("🚀 Generating 200 mock contact records...")
    
    # Generate 200 completely unique test rows
    all_contacts = []
    for i in range(1, 201):
        all_contacts.append({
            "properties": {
                "email": f"bulk.test.user_{i}@sureshift.dev",
                "firstname": f"SureShift",
                "lastname": f"Tester #{i}",
                "phone": f"+1-555-019-{i:03d}"
            }
        })

    # HubSpot's v3 Batch API strictly allows a maximum of 100 records per single batch transaction request
    chunk_1 = all_contacts[0:100]
    chunk_2 = all_contacts[100:200]

    url = "https://api.hubapi.com/crm/v3/objects/contacts/batch/create"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
        # PUSH BATCH #1 (Records 1-100)
        print("⏳ Streaming first batch of 100 contacts to HubSpot...")
        res1 = await client.post(url, headers=headers, json={"inputs": chunk_1})
        if res1.status_code in [200, 201]:
            print("✅ First 100 records successfully injected!")
        else:
            print(f"❌ Batch 1 failed: {res1.text}")
            return

        # PUSH BATCH #2 (Records 101-200)
        print("⏳ Streaming second batch of 100 contacts to HubSpot...")
        res2 = await client.post(url, headers=headers, json={"inputs": chunk_2})
        if res2.status_code in [200, 201]:
            print("✅ Final 100 records successfully injected!")
            print("\n🎉 PORTAL SEEDING COMPLETE! Your Sandbox account now has 200 bulk rows ready.")
        else:
            print(f"❌ Batch 2 failed: {res2.text}")

if __name__ == "__main__":
    asyncio.run(seed_bulk_contacts())