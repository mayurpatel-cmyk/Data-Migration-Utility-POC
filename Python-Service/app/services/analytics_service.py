"""
Aggregation logic for the History & Analytics dashboard. Takes the raw rows
already fetched from `migration_history` / `validation_history` (via
Supabase) and turns them into the shapes the frontend charts/tables want:
overview KPIs, per-object and per-pathway breakdowns, a day-by-day trend,
and a merged top-errors list.

Deliberately kept as pure functions over plain dicts (no Supabase calls in
here) -- the route layer (migration_history.py) owns fetching/filtering,
this just aggregates whatever rows it's handed. That keeps it trivially
testable and reusable if a second surface (e.g. an admin view) ever needs
the same numbers.
"""
from collections import defaultdict


def _day_key(created_at: str) -> str:
    """created_at comes back from Supabase as an ISO-8601 string; this
    normalizes it to a YYYY-MM-DD bucket for the trend chart regardless of
    whether it includes a timezone offset or fractional seconds."""
    if not created_at:
        return "unknown"
    try:
        return created_at[:10]
    except Exception:
        return "unknown"


def _pct(numerator: int, denominator: int) -> float:
    if not denominator:
        return 0.0
    return round((numerator / denominator) * 100, 1)


class AnalyticsService:

    @staticmethod
    def build_dashboard(migration_rows: list, validation_rows: list) -> dict:
        return {
            "overview": AnalyticsService._build_overview(migration_rows, validation_rows),
            "byObject": AnalyticsService._build_by_object(migration_rows),
            "byPathway": AnalyticsService._build_by_pathway(migration_rows),
            "trend": AnalyticsService._build_trend(migration_rows, validation_rows),
            "topErrors": AnalyticsService._build_top_errors(migration_rows, validation_rows),
            "validationByObject": AnalyticsService._build_validation_by_object(validation_rows),
        }

    @staticmethod
    def _build_overview(migration_rows: list, validation_rows: list) -> dict:
        total_records = sum(r.get("total_records", 0) for r in migration_rows)
        total_success = sum(r.get("success_count", 0) for r in migration_rows)
        total_errors = sum(r.get("error_count", 0) for r in migration_rows)

        total_validated = sum(r.get("total_records", 0) for r in validation_rows)
        total_valid = sum(r.get("valid_count", 0) for r in validation_rows)
        total_invalid = sum(r.get("invalid_count", 0) for r in validation_rows)
        total_duplicates = sum(r.get("duplicate_count", 0) for r in validation_rows)

        return {
            "totalMigrations": len(migration_rows),
            "totalRecordsMigrated": total_records,
            "totalSuccess": total_success,
            "totalErrors": total_errors,
            "successRate": _pct(total_success, total_records),
            "totalValidationRuns": len(validation_rows),
            "totalValidated": total_validated,
            "totalValid": total_valid,
            "totalInvalid": total_invalid,
            "totalDuplicates": total_duplicates,
            "validationPassRate": _pct(total_valid, total_validated),
        }

    @staticmethod
    def _build_by_object(migration_rows: list) -> list:
        buckets = defaultdict(lambda: {"migrations": 0, "totalRecords": 0, "success": 0, "errors": 0})
        for row in migration_rows:
            obj = row.get("target_object") or "Unknown"
            b = buckets[obj]
            b["migrations"] += 1
            b["totalRecords"] += row.get("total_records", 0)
            b["success"] += row.get("success_count", 0)
            b["errors"] += row.get("error_count", 0)

        result = [
            {
                "object": obj,
                "migrations": b["migrations"],
                "totalRecords": b["totalRecords"],
                "success": b["success"],
                "errors": b["errors"],
                "successRate": _pct(b["success"], b["totalRecords"]),
            }
            for obj, b in buckets.items()
        ]
        return sorted(result, key=lambda r: r["totalRecords"], reverse=True)

    @staticmethod
    def _build_by_pathway(migration_rows: list) -> list:
        buckets = defaultdict(lambda: {"migrations": 0, "totalRecords": 0, "success": 0, "errors": 0})
        for row in migration_rows:
            key = (row.get("source_crm") or "unknown", row.get("target_crm") or "unknown")
            b = buckets[key]
            b["migrations"] += 1
            b["totalRecords"] += row.get("total_records", 0)
            b["success"] += row.get("success_count", 0)
            b["errors"] += row.get("error_count", 0)

        result = [
            {
                "sourceCrm": source,
                "targetCrm": target,
                "migrations": b["migrations"],
                "totalRecords": b["totalRecords"],
                "success": b["success"],
                "errors": b["errors"],
                "successRate": _pct(b["success"], b["totalRecords"]),
            }
            for (source, target), b in buckets.items()
        ]
        return sorted(result, key=lambda r: r["totalRecords"], reverse=True)

    @staticmethod
    def _build_trend(migration_rows: list, validation_rows: list) -> list:
        buckets = defaultdict(lambda: {"migrations": 0, "success": 0, "errors": 0, "validationRuns": 0, "valid": 0, "invalid": 0})

        for row in migration_rows:
            b = buckets[_day_key(row.get("created_at"))]
            b["migrations"] += 1
            b["success"] += row.get("success_count", 0)
            b["errors"] += row.get("error_count", 0)

        for row in validation_rows:
            b = buckets[_day_key(row.get("created_at"))]
            b["validationRuns"] += 1
            b["valid"] += row.get("valid_count", 0)
            b["invalid"] += row.get("invalid_count", 0)

        return [
            {"date": day, **stats}
            for day, stats in sorted(buckets.items())
            if day != "unknown"
        ]

    @staticmethod
    def _build_top_errors(migration_rows: list, validation_rows: list, top_n: int = 8) -> list:
        """Merges the error_summary jsonb already computed at write time
        (by AuditService.build_error_summary) across every migration AND
        validation row in scope, so this stays O(rows) instead of
        re-parsing every error CSV on each dashboard load."""
        counts = defaultdict(int)
        samples = {}
        for row in list(migration_rows) + list(validation_rows):
            for item in (row.get("error_summary") or []):
                category = item.get("category", "Other")
                counts[category] += item.get("count", 0)
                if category not in samples and item.get("sample"):
                    samples[category] = item.get("sample")

        ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        return [
            {"category": cat, "count": count, "sample": samples.get(cat)}
            for cat, count in ranked[:top_n]
        ]

    @staticmethod
    def _build_validation_by_object(validation_rows: list) -> list:
        buckets = defaultdict(lambda: {"totalValidated": 0, "valid": 0, "invalid": 0, "duplicates": 0})
        for row in validation_rows:
            obj = row.get("target_object") or "Unknown"
            b = buckets[obj]
            b["totalValidated"] += row.get("total_records", 0)
            b["valid"] += row.get("valid_count", 0)
            b["invalid"] += row.get("invalid_count", 0)
            b["duplicates"] += row.get("duplicate_count", 0)

        result = [
            {
                "object": obj,
                "totalValidated": b["totalValidated"],
                "valid": b["valid"],
                "invalid": b["invalid"],
                "duplicates": b["duplicates"],
                "passRate": _pct(b["valid"], b["totalValidated"]),
            }
            for obj, b in buckets.items()
        ]
        return sorted(result, key=lambda r: r["totalValidated"], reverse=True)