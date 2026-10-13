import { createClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import 'dotenv/config';

interface CsvUserRow {
  email: string;
  password: string;
  full_name?: string;
}

interface ImportResult {
  email: string;
  success: boolean;
  userId?: string;
  error?: string;
}


const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function importUsersFromCsv(csvPath: string): Promise<ImportResult[]> {
  const fileContent = readFileSync(csvPath, 'utf-8');
  const rows: CsvUserRow[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const results: ImportResult[] = [];
  const BATCH_SIZE = 10;
  const DELAY_MS = 300;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (row): Promise<ImportResult> => {
        if (!row.email || !row.password) {
          return { email: row.email ?? 'unknown', success: false, error: 'Missing email or password' };
        }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email: row.email,
          password: row.password,
          email_confirm: true,
          user_metadata: {
            full_name: row.full_name ?? null,
          },
        });

        if (error) {
          return { email: row.email, success: false, error: error.message };
        }

        return { email: row.email, success: true, userId: data.user?.id };
      })
    );

    results.push(...batchResults);

    if (i + BATCH_SIZE < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  return results;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: tsx import-users.ts <path-to-csv>');
    process.exit(1);
  }

  const results = await importUsersFromCsv(csvPath);
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`\nImported: ${succeeded.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    failed.forEach((f) => console.log(`  ${f.email}: ${f.error}`));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});