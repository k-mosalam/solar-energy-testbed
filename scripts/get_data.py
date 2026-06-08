from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
import xlrd
from playwright.sync_api import Page, sync_playwright


DEFAULT_USERNAME = "naming201@berkeley.edu"
DEFAULT_PASSWORD = "Solarpanel1"
DEFAULT_STATION_ID = "f421d697-3a6e-4e22-81cc-e25c6435ba7d"
DEFAULT_REFRESH_DAYS = 3
CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js"


@dataclass
class Point:
    full_time: str
    time_label: str
    pv: float | None
    soc: float | None
    battery: float | None
    grid: float | None
    load: float | None


def sleep(ms: int) -> None:
    time.sleep(ms / 1000)


def pad(value: int) -> str:
    return str(value).zfill(2)


def parse_cli(argv: list[str]) -> tuple[list[str], dict[str, Any]]:
    positional: list[str] = []
    options: dict[str, Any] = {}
    index = 0

    while index < len(argv):
        arg = argv[index]
        if not arg.startswith("--"):
            positional.append(arg)
            index += 1
            continue

        key = arg[2:]
        next_arg = argv[index + 1] if index + 1 < len(argv) else None
        if not next_arg or next_arg.startswith("--"):
            options[key] = True
            index += 1
            continue

        options[key] = next_arg
        index += 2

    return positional, options


def parse_ymd(value: str) -> date | None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None

    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def format_ymd(value: date) -> str:
    return value.strftime("%Y-%m-%d")


def format_page_date(value: date) -> str:
    return value.strftime("%m.%d.%Y")


def parse_page_date(value: str) -> date | None:
    value = value.strip()
    if not re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", value):
        return None
    return parse_ymd(f"{value[6:10]}-{value[0:2]}-{value[3:5]}")


def escape_html(value: Any) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def add_days(value: date, days: int) -> date:
    return value + timedelta(days=days)


def diff_days(later: date, earlier: date) -> int:
    return (later - earlier).days


def list_local_dates(out_dir: Path) -> list[str]:
    if not out_dir.exists():
        return []

    dates: list[str] = []
    for name in os.listdir(out_dir):
        match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})_power\.xls", name, re.IGNORECASE)
        if match:
            dates.append(match.group(1))
    return sorted(dates)


def build_target_dates(
    *,
    mode: str,
    explicit_date: date | None,
    since_date: date | None,
    latest_remote_date: date,
    local_dates: list[str],
    refresh_days: int,
) -> list[str]:
    if mode == "date":
        return [format_ymd(explicit_date)]

    if mode == "since":
        dates: list[str] = []
        cursor = since_date
        while cursor <= latest_remote_date:
            dates.append(format_ymd(cursor))
            cursor = add_days(cursor, 1)
        return dates

    refresh_start = add_days(latest_remote_date, -(refresh_days - 1))
    latest_local_date = parse_ymd(local_dates[-1]) if local_dates else None

    start_date = refresh_start
    if latest_local_date:
        next_missing_date = add_days(latest_local_date, 1)
        start_date = next_missing_date if next_missing_date < refresh_start else refresh_start

    dates: list[str] = []
    cursor = start_date
    while cursor <= latest_remote_date:
        dates.append(format_ymd(cursor))
        cursor = add_days(cursor, 1)
    return dates


def get_number(row: list[Any], index: int) -> float | None:
    if index == -1 or index >= len(row):
        return None
    value = row[index]
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_power_workbook(xls_path: Path) -> tuple[str, list[Point]]:
    workbook = xlrd.open_workbook(str(xls_path))
    sheet = workbook.sheet_by_index(0)
    rows = [sheet.row_values(i) for i in range(sheet.nrows)]

    header_index = -1
    for idx, row in enumerate(rows):
        normalized = ["" if cell is None else str(cell).strip() for cell in row]
        if normalized and normalized[0] == "Time" and "PV(W)" in normalized:
            header_index = idx
            break

    if header_index == -1:
        raise RuntimeError(f"could not find power header row in {xls_path}")

    headers = ["" if value is None else str(value).strip() for value in rows[header_index]]
    time_index = headers.index("Time") if "Time" in headers else -1
    pv_index = headers.index("PV(W)") if "PV(W)" in headers else -1
    soc_index = headers.index("SOC(%)") if "SOC(%)" in headers else -1
    battery_index = headers.index("Battery(W)") if "Battery(W)" in headers else -1
    grid_index = headers.index("Grid (W)") if "Grid (W)" in headers else -1
    load_index = headers.index("Load(W)") if "Load(W)" in headers else -1

    if time_index == -1 or pv_index == -1:
        raise RuntimeError(f"missing required columns in {xls_path}")

    plant_name = (
        str(rows[1][1])
        if len(rows) > 1 and len(rows[1]) > 1 and rows[1][1] not in (None, "")
        else "Plant Power"
    )

    series: list[Point] = []
    for row in rows[header_index + 1 :]:
        if time_index >= len(row) or not row[time_index]:
            continue

        full_time = str(row[time_index]).strip()
        time_label = full_time.split(" ")[1][:5] if " " in full_time else full_time
        series.append(
            Point(
                full_time=full_time,
                time_label=time_label,
                pv=get_number(row, pv_index),
                soc=get_number(row, soc_index),
                battery=get_number(row, battery_index),
                grid=get_number(row, grid_index),
                load=get_number(row, load_index),
            )
        )

    return plant_name, series


def build_chart_html(*, ymd: str, plant_name: str, series: list[Point]) -> str:
    labels = [point.time_label for point in series]
    full_times = [point.full_time for point in series]
    pv_data = [point.pv for point in series]

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Solar Panel {escape_html(ymd)}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --grid: rgba(148, 163, 184, 0.18);
      --border: #dbe3ef;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--text);
    }}
    .wrap {{
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 20px 12px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }}
    .header {{
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }}
    .title {{
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
      margin: 0;
    }}
    .meta {{
      color: var(--muted);
      font-size: 14px;
      line-height: 1.4;
      text-align: right;
    }}
    .chart-box {{
      position: relative;
      height: min(68vh, 680px);
      min-height: 380px;
    }}
    canvas {{
      width: 100% !important;
      height: 100% !important;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Solar Panel</h1>
          <div class="meta">{escape_html(ymd)} PV</div>
        </div>
        <div class="meta">Hover to inspect values</div>
      </div>
      <div class="chart-box">
        <canvas id="powerChart"></canvas>
      </div>
    </div>
  </div>
  <script src="{CHART_JS_URL}"></script>
  <script>
    const labels = {json.dumps(labels)};
    const fullTimes = {json.dumps(full_times)};
    const datasets = [{{
      label: 'PV',
      data: {json.dumps(pv_data)},
      borderColor: '#10b7d8',
      backgroundColor: 'rgba(16, 183, 216, 0.16)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 16,
      tension: 0.15,
      yAxisID: 'y'
    }}];

    const chart = new Chart(document.getElementById('powerChart'), {{
      type: 'line',
      data: {{ labels, datasets }},
      options: {{
        responsive: true,
        maintainAspectRatio: false,
        interaction: {{
          mode: 'index',
          intersect: false
        }},
        plugins: {{
          legend: {{
            display: true,
            position: 'top',
            labels: {{
              usePointStyle: true,
              boxWidth: 10,
              boxHeight: 10,
              padding: 18,
              color: '#1f2937'
            }}
          }},
          tooltip: {{
            callbacks: {{
              title(items) {{
                return items.length ? fullTimes[items[0].dataIndex] : '';
              }},
              label(context) {{
                const label = context.dataset.label || '';
                const value = context.raw == null ? '-' : context.raw;
                return label + ': ' + value + ' W';
              }}
            }}
          }}
        }},
        scales: {{
          x: {{
            grid: {{ color: 'rgba(148, 163, 184, 0.12)' }},
            ticks: {{
              color: '#475569',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 14
            }}
          }},
          y: {{
            position: 'left',
            title: {{
              display: true,
              text: 'Watts',
              color: '#475569'
            }},
            grid: {{ color: 'rgba(148, 163, 184, 0.18)' }},
            ticks: {{ color: '#475569' }}
          }}
        }}
      }}
    }});
  </script>
</body>
</html>"""


def generate_chart_from_xls(xls_path: Path, ymd: str) -> Path:
    plant_name, series = parse_power_workbook(xls_path)
    if not series:
        raise RuntimeError(f"no data rows found in {xls_path}")

    html = build_chart_html(ymd=ymd, plant_name=plant_name, series=series)
    html_path = Path(str(xls_path).replace("_power.xls", "_solarpanel.html"))
    html_path.write_text(html, encoding="utf-8")
    return html_path


def login(page: Page, username: str, password: str) -> None:
    print("Login...")
    try:
        page.goto("https://www.semsportal.com/home/login", wait_until="networkidle", timeout=30000)
    except Exception:
        pass
    try:
        page.click("#readStatement")
    except Exception:
        pass
    sleep(200)
    try:
        page.fill("#username", username)
    except Exception:
        pass
    try:
        page.fill("#password", password)
    except Exception:
        pass
    try:
        page.click("#btnLogin")
    except Exception:
        try:
            page.keyboard.press("Enter")
        except Exception:
            pass
    sleep(5000)


def open_power_page(page: Page, target_url: str) -> None:
    print("Open power page...")
    try:
        page.goto(target_url, wait_until="networkidle", timeout=30000)
    except Exception:
        pass
    page.wait_for_selector(".station-date-picker_con .el-input__inner", timeout=30000)
    page.wait_for_selector(".station-date-picker_left", timeout=30000)
    page.wait_for_selector(".station-date-picker_right", timeout=30000)
    page.wait_for_selector(".goodwe-station-charts__export", timeout=30000)
    sleep(1500)


def get_current_page_date(page: Page) -> date:
    raw_value = page.locator(".station-date-picker_con .el-input__inner").input_value()
    parsed = parse_page_date(raw_value)
    if not parsed:
        raise RuntimeError(f"unable to parse page date: {raw_value}")
    return parsed


def is_right_button_disabled(page: Page) -> bool:
    return bool(page.locator(".station-date-picker_right").evaluate("el => el.disabled"))


def click_date_button(page: Page, selector: str) -> None:
    with page.expect_response(
        lambda response: "/api/v2/Charts/GetPlantPowerChart" in response.url and response.request.method == "POST",
        timeout=30000,
    ):
        page.click(selector)
    sleep(1500)


def move_to_latest_date(page: Page) -> date:
    while not is_right_button_disabled(page):
        click_date_button(page, ".station-date-picker_right")
    return get_current_page_date(page)


def move_to_target_date(page: Page, latest_date: date, target_date: date) -> date:
    offset = diff_days(latest_date, target_date)
    if offset < 0:
        raise RuntimeError(
            f"target date {format_ymd(target_date)} is newer than remote latest {format_ymd(latest_date)}"
        )

    current = get_current_page_date(page)
    current_offset = diff_days(latest_date, current)
    remaining = offset - current_offset

    if remaining < 0:
        raise RuntimeError(
            f"current page date {format_ymd(current)} is already older than target {format_ymd(target_date)}"
        )

    for _ in range(remaining):
        click_date_button(page, ".station-date-picker_left")

    current = get_current_page_date(page)
    if format_ymd(current) != format_ymd(target_date):
        raise RuntimeError(
            f"failed to reach target date {format_ymd(target_date)}; current page date is {format_ymd(current)}"
        )

    return current


def export_current_date(page: Page, out_dir: Path, ymd: str) -> Path:
    request_bodies: dict[str, str] = {}

    def on_request(request: Any) -> None:
        if re.search(r"ExportPowerstationPac|GetStationPowerDataFilePath", request.url) and request.method == "POST":
            request_bodies[request.url] = request.post_data or ""

    page.on("request", on_request)

    try:
        with page.expect_response(
            lambda response: "/api/v1/PowerStation/ExportPowerstationPac" in response.url
            and response.request.method == "POST",
            timeout=30000,
        ) as export_response_info, page.expect_response(
            lambda response: "/api/v1/ReportData/GetStationPowerDataFilePath" in response.url
            and response.request.method == "POST",
            timeout=30000,
        ) as file_response_info:
            print(f"[{ymd}] Trigger export...")
            clicked = page.evaluate(
                """() => {
                  const exportButton = document.querySelector('.goodwe-station-charts__export');
                  if (!exportButton) return false;
                  exportButton.click();
                  return true;
                }"""
            )
            if not clicked:
                raise RuntimeError("export button not found")

        export_response = export_response_info.value
        file_response = file_response_info.value
        export_json = export_response.json()
        file_json = file_response.json()

        print(
            f"[{ymd}] Export request body:",
            request_bodies.get("https://us.semsportal.com/api/v1/PowerStation/ExportPowerstationPac", ""),
        )
        print(f"[{ymd}] Export response:", json.dumps(export_json))
        print(
            f"[{ymd}] File request body:",
            request_bodies.get("https://us.semsportal.com/api/v1/ReportData/GetStationPowerDataFilePath", ""),
        )
        print(f"[{ymd}] File response:", json.dumps(file_json))

        file_url = ((file_json or {}).get("data") or {}).get("file_path")
        if not file_url:
            raise RuntimeError("file_path not found in export response")

        print(f"[{ymd}] Downloading {file_url}")
        resp = requests.get(file_url, timeout=60)
        resp.raise_for_status()

        out_path = out_dir / f"{ymd}_power.xls"
        out_path.write_bytes(resp.content)
        print(f"[{ymd}] Saved exported file to {out_path}")
        html_path = generate_chart_from_xls(out_path, ymd)
        print(f"[{ymd}] Generated chart at {html_path}")
        return out_path
    finally:
        page.remove_listener("request", on_request)


def main() -> None:
    positional, options = parse_cli(sys.argv[1:])
    username = os.environ.get("GOODWE_USERNAME") or (positional[0] if len(positional) > 0 else DEFAULT_USERNAME)
    password = os.environ.get("GOODWE_PASSWORD") or (positional[1] if len(positional) > 1 else DEFAULT_PASSWORD)
    station_id = os.environ.get("STATION_ID") or (positional[2] if len(positional) > 2 else DEFAULT_STATION_ID)
    mode = "date" if options.get("date") else ("since" if options.get("since") else "update")
    refresh_days = int(options.get("refresh-days", DEFAULT_REFRESH_DAYS))

    explicit_date = parse_ymd(options["date"]) if options.get("date") else None
    since_date = parse_ymd(options["since"]) if options.get("since") else None

    if options.get("date") and not explicit_date:
        raise RuntimeError(f"invalid --date value: {options['date']}")
    if options.get("since") and not since_date:
        raise RuntimeError(f"invalid --since value: {options['since']}")
    if refresh_days < 1:
        raise RuntimeError(f"invalid --refresh-days value: {options.get('refresh-days')}")

    out_dir = Path(__file__).resolve().parent.parent / "docs" / "goodwe-exports"
    out_dir.mkdir(exist_ok=True)

    target_url = f"https://www.semsportal.com/powerstation/PowerStatusSnMin/{station_id}"
    local_dates = list_local_dates(out_dir)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
        context = browser.new_context(
            viewport={"width": 1600, "height": 1000},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            login(page, username, password)
            open_power_page(page, target_url)

            latest_remote_date = move_to_latest_date(page)
            print("Remote latest date:", format_ymd(latest_remote_date))

            if mode == "date" and explicit_date > latest_remote_date:
                raise RuntimeError(
                    f"requested date {format_ymd(explicit_date)} is newer than remote latest "
                    f"{format_ymd(latest_remote_date)}"
                )
            if mode == "since" and since_date > latest_remote_date:
                print("Nothing to download: requested start date is newer than remote latest date.")
                return

            target_dates = sorted(
                build_target_dates(
                    mode=mode,
                    explicit_date=explicit_date,
                    since_date=since_date,
                    latest_remote_date=latest_remote_date,
                    local_dates=local_dates,
                    refresh_days=refresh_days,
                ),
                reverse=True,
            )

            if not target_dates:
                print("Nothing to download.")
                return

            print("Target dates:", ", ".join(target_dates))

            for ymd in target_dates:
                target_date = parse_ymd(ymd)
                move_to_target_date(page, latest_remote_date, target_date)
                page_date = get_current_page_date(page)
                print(f"[{ymd}] Page date is {format_ymd(page_date)} ({format_page_date(page_date)})")
                export_current_date(page, out_dir, ymd)

            print("Done")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
