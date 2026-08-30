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
try:
    import xlwt
except ImportError:
    xlwt = None
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


DEFAULT_USERNAME = "naming201@berkeley.edu"
DEFAULT_PASSWORD = "Solarpanel1"
DEFAULT_STATION_ID = "f421d697-3a6e-4e22-81cc-e25c6435ba7d"
DEFAULT_REFRESH_DAYS = 3
CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js"
CLASSIC_LOGIN_URL = "https://www.semsportal.com/home/login"
SEMS_PLUS_URL = "https://semsplus.goodwe.com/"


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


def update_energy_page(out_dir: Path) -> None:
    dates = sorted(list_local_dates(out_dir), reverse=True)
    energy_path = out_dir.parent / "energy.html"
    if not dates or not energy_path.exists():
        return

    latest = dates[0]
    content = energy_path.read_text(encoding="utf-8")
    content = re.sub(
        r"goodwe-exports/\d{4}-\d{2}-\d{2}_(solarpanel\.html|power\.xls)",
        lambda match: f"goodwe-exports/{latest}_{match.group(1)}",
        content,
    )
    content = re.sub(
        r'(<h3 id="current-files-title">Generated exports for )\d{4}-\d{2}-\d{2}(</h3>)',
        rf"\g<1>{latest}\g<2>",
        content,
    )
    content = re.sub(
        r'(<p class="selected-date" id="selected-date-label">)\d{4}-\d{2}-\d{2}(</p>)',
        rf"\g<1>{latest}\g<2>",
        content,
    )
    date_lines = "\n".join(
        f'      "{ymd}"{"," if index < len(dates) - 1 else ""}'
        for index, ymd in enumerate(dates)
    )
    content, replacements = re.subn(
        r"(    const availableDates = \[\n).*?(\n    \];)",
        rf"\g<1>{date_lines}\g<2>",
        content,
        count=1,
        flags=re.DOTALL,
    )
    if replacements != 1:
        raise RuntimeError(f"unable to update availableDates in {energy_path}")
    energy_path.write_text(content, encoding="utf-8")
    print(f"Updated Energy page; latest available date is {latest}")


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
    soc_data = [point.soc for point in series]
    battery_data = [point.battery for point in series]
    load_data = [point.load for point in series]
    has_data = bool(series)
    status_text = (
        "The export contains timestamped power samples for this day."
        if has_data
        else "This export contains headers only. No timestamped power samples were available for this day."
    )

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
      margin-bottom: 22px;
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
    .subcopy {{
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }}
    .status-note {{
      margin: 0 0 18px;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #eef4fb;
      color: #334155;
      font-size: 14px;
      line-height: 1.5;
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
    <div class="status-note">{escape_html(status_text)}</div>
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Solar Panel</h1>
          <div class="meta">{escape_html(ymd)} PV</div>
          <p class="subcopy">PV output power measured from the solar generation side.</p>
        </div>
        <div class="meta">Hover to inspect values</div>
      </div>
      <div class="chart-box">
        <canvas id="powerChart"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Battery State of Charge</h1>
          <div class="meta">{escape_html(ymd)} SOC</div>
          <p class="subcopy">SOC shows the battery's available charge as a percentage of its usable capacity.</p>
        </div>
        <div class="meta">Battery charge level</div>
      </div>
      <div class="chart-box">
        <canvas id="socChart"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Battery Power</h1>
          <div class="meta">{escape_html(ymd)} Battery</div>
          <p class="subcopy">Battery power reported by SEMS. Positive and negative values indicate opposite power-flow directions.</p>
        </div>
        <div class="meta">Charge and discharge power</div>
      </div>
      <div class="chart-box">
        <canvas id="batteryChart"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Load Power</h1>
          <div class="meta">{escape_html(ymd)} Load</div>
          <p class="subcopy">Load power is the site consumption reported by the GoodWe SEMS platform.</p>
        </div>
        <div class="meta">SEMS site consumption</div>
      </div>
      <div class="chart-box">
        <canvas id="loadChart"></canvas>
      </div>
    </div>
  </div>
  <script src="{CHART_JS_URL}"></script>
  <script>
    const labels = {json.dumps(labels)};
    const fullTimes = {json.dumps(full_times)};
    const pvDatasets = [{{
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

    const loadDatasets = [{{
      label: 'Load Power',
      data: {json.dumps(load_data)},
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.18)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 16,
      tension: 0.15,
      yAxisID: 'y'
    }}];

    const socDatasets = [{{
      label: 'Battery SOC',
      data: {json.dumps(soc_data)},
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139, 92, 246, 0.16)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 16,
      tension: 0.15,
      unit: '%',
      yAxisID: 'y'
    }}];

    const batteryDatasets = [{{
      label: 'Battery Power',
      data: {json.dumps(battery_data)},
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.16)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 16,
      tension: 0.15,
      yAxisID: 'y'
    }}];

    function buildChart(canvasId, datasets, axisTitle = 'Watts', suggestedMin, suggestedMax) {{
      return new Chart(document.getElementById(canvasId), {{
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
                  const unit = context.dataset.unit || ' W';
                  return label + ': ' + value + unit;
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
              suggestedMin,
              suggestedMax,
              title: {{
                display: true,
                text: axisTitle,
                color: '#475569'
              }},
              grid: {{ color: 'rgba(148, 163, 184, 0.18)' }},
              ticks: {{ color: '#475569' }}
            }}
          }}
        }}
      }});
    }}

    buildChart('powerChart', pvDatasets);
    buildChart('socChart', socDatasets, 'State of Charge (%)', 0, 100);
    buildChart('batteryChart', batteryDatasets);
    buildChart('loadChart', loadDatasets);
  </script>
</body>
</html>"""


def generate_chart_from_xls(xls_path: Path, ymd: str) -> Path:
    plant_name, series = parse_power_workbook(xls_path)
    html = build_chart_html(ymd=ymd, plant_name=plant_name, series=series)
    html_path = Path(str(xls_path).replace("_power.xls", "_solarpanel.html"))
    html_path.write_text(html, encoding="utf-8")
    return html_path


def write_sems_plus_workbook(
    out_path: Path,
    plant_name: str,
    power_response: dict[str, Any],
) -> None:
    if xlwt is None:
        raise RuntimeError(
            "SEMS+ XLS writing requires xlwt. Run: "
            "python -m pip install -r requirements-python.txt"
        )

    data_lists = ((power_response.get("data") or {}).get("dataList") or [])
    series_by_item = {
        str(series.get("item", "")): series
        for series in data_lists
        if isinstance(series, dict)
    }
    aliases = {
        "pv": ("pSystem", "pv", "solar"),
        "soc": ("soc", "batterySoc"),
        "battery": ("pBattery", "pBat", "pStorage", "battery", "batteryPower"),
        "grid": ("pGrid", "pMeter", "grid", "gridPower", "meterPower"),
        "load": ("pConsum", "pLoad", "load"),
    }

    print(
        "SEMS+ power series received:",
        ", ".join(series_by_item) if series_by_item else "none",
    )

    values: dict[str, dict[str, float | None]] = {}
    all_times: set[str] = set()
    for output_name, item_names in aliases.items():
        series = next(
            (series_by_item[name] for name in item_names if name in series_by_item),
            None,
        )
        unit = str((series or {}).get("unit") or "")
        multiplier = 1000.0 if unit.lower() == "kw" and output_name != "soc" else 1.0
        item_values: dict[str, float | None] = {}
        for point in (series or {}).get("powerData") or []:
            timestamp = str(point.get("tp") or "")
            raw_power = point.get("power")
            value = float(raw_power) * multiplier if raw_power is not None else None
            if timestamp:
                item_values[timestamp] = value
                all_times.add(timestamp)
        values[output_name] = item_values

    # SEMS+ can return only empty tariff curves when an offline station has no
    # power samples. Preserve the day as an empty export instead of failing.
    if not all_times:
        for series in data_lists:
            for point in series.get("powerData") or []:
                timestamp = str(point.get("tp") or "")
                if timestamp:
                    all_times.add(timestamp)

    workbook = xlwt.Workbook()
    sheet = workbook.add_sheet("Power")
    sheet.write(1, 0, "Plant")
    sheet.write(1, 1, plant_name)
    headers = ["Time", "PV(W)", "SOC(%)", "Battery(W)", "Grid (W)", "Load(W)"]
    for column, header in enumerate(headers):
        sheet.write(2, column, header)

    output_row = 3
    for timestamp in sorted(all_times):
        try:
            parsed_time = datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if parsed_time.minute % 5 != 0:
            continue
        display_time = parsed_time.strftime("%m.%d.%Y %H:%M:%S")
        sheet.write(output_row, 0, display_time)
        for column, output_name in enumerate(
            ("pv", "soc", "battery", "grid", "load"),
            start=1,
        ):
            value = values.get(output_name, {}).get(timestamp)
            if value is not None:
                sheet.write(output_row, column, value)
        output_row += 1

    workbook.save(str(out_path))


def first_visible(page: Page, selectors: list[str]):
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(locator.count()):
            candidate = locator.nth(index)
            if candidate.is_visible():
                return candidate
    return None


def login(page: Page, username: str, password: str, platform: str) -> None:
    print("Login...")
    login_url = SEMS_PLUS_URL if platform == "plus" else CLASSIC_LOGIN_URL
    try:
        page.goto(login_url, wait_until="networkidle", timeout=30000)
    except PlaywrightTimeoutError:
        print("Login page did not reach network idle within 30 seconds; continuing...")

    if platform == "plus":
        email_input = first_visible(
            page,
            [
                'input[type="email"]',
                'input[placeholder*="email" i]',
                'input[autocomplete="username"]',
                'input[type="text"]',
            ],
        )
        password_input = first_visible(
            page,
            ['input[type="password"]', 'input[autocomplete="current-password"]'],
        )
        if not email_input or not password_input:
            raise RuntimeError(
                f"Unable to find the SEMS+ login inputs. Current URL: {page.url}"
            )
        email_input.fill(username)
        password_input.fill(password)

        agreement = page.locator(
            'label.ant-checkbox-wrapper:has-text("I have read and agreed")'
        ).first
        if not agreement.is_visible():
            raise RuntimeError("Unable to find the SEMS+ service-agreement checkbox.")
        if "ant-checkbox-wrapper-checked" not in (agreement.get_attribute("class") or ""):
            agreement.click()

        accept_cookies = page.locator('button:has-text("Accept cookies")').first
        if accept_cookies.is_visible():
            accept_cookies.click()

        login_button = first_visible(
            page,
            [
                'button:has-text("Login")',
                'button:has-text("Log in")',
                'button[type="submit"]',
                '[role="button"]:has-text("Login")',
            ],
        )
        if not login_button:
            raise RuntimeError("Unable to find the SEMS+ login button.")
        login_button.click()
        try:
            page.wait_for_url(
                lambda url: "#/login" not in str(url),
                timeout=30000,
            )
        except PlaywrightTimeoutError:
            print("SEMS+ URL did not change within 30 seconds; checking page content...")
        sleep(2000)
        print("SEMS+ URL after login:", page.url)
        return

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


def open_power_page(page: Page, target_url: str, platform: str) -> None:
    print("Open power page...")
    if platform == "classic":
        try:
            page.goto(target_url, wait_until="networkidle", timeout=30000)
        except PlaywrightTimeoutError:
            print("Power page did not reach network idle within 30 seconds; checking the rendered page...")

    date_selector = (
        '#chartBox input[placeholder="Select date"]'
        if platform == "plus"
        else ".station-date-picker_con .el-input__inner"
    )
    try:
        page.wait_for_selector(date_selector, timeout=30000)
    except PlaywrightTimeoutError as error:
        debug_dir = Path(__file__).resolve().parent.parent / "debug"
        debug_dir.mkdir(exist_ok=True)
        screenshot_path = debug_dir / "sems-power-page.png"
        html_path = debug_dir / "sems-power-page.html"
        page.screenshot(path=str(screenshot_path), full_page=True)
        html_path.write_text(page.content(), encoding="utf-8")
        print("Current URL:", page.url)
        print("Page title:", page.title())
        print("Debug screenshot:", screenshot_path)
        print("Debug HTML:", html_path)
        raise RuntimeError(
            "SEMS power page did not show the expected date picker. "
            "Check the browser window and the saved debug files; login may have failed "
            "or the SEMS page structure may have changed."
        ) from error

    if platform == "plus":
        page.wait_for_selector('#chartBox [aria-label="caret-left"]', timeout=30000)
        page.wait_for_selector('#chartBox [aria-label="caret-right"]', timeout=30000)
        print("SEMS+ station power page detected.")
    else:
        page.wait_for_selector(".station-date-picker_left", timeout=30000)
        page.wait_for_selector(".station-date-picker_right", timeout=30000)
        page.wait_for_selector(".goodwe-station-charts__export", timeout=30000)
    sleep(1500)


def get_current_page_date(page: Page, platform: str) -> date:
    selector = (
        '#chartBox input[placeholder="Select date"]'
        if platform == "plus"
        else ".station-date-picker_con .el-input__inner"
    )
    raw_value = page.locator(selector).input_value()
    if platform == "plus":
        try:
            parsed = datetime.strptime(raw_value.strip(), "%d/%m/%Y").date()
        except ValueError:
            parsed = None
    else:
        parsed = parse_page_date(raw_value)
    if not parsed:
        raise RuntimeError(f"unable to parse page date: {raw_value}")
    return parsed


def is_right_button_disabled(page: Page, platform: str) -> bool:
    if platform == "plus":
        class_name = (
            page.locator('#chartBox [aria-label="caret-right"]').get_attribute("class")
            or ""
        )
        return "Disabled" in class_name
    return bool(page.locator(".station-date-picker_right").evaluate("el => el.disabled"))


def click_date_button(page: Page, selector: str, platform: str) -> None:
    if platform == "plus":
        responses: list[str] = []

        def record_response(response: Any) -> None:
            if response.request.method == "POST" and (
                "station" in response.url.lower()
                or "chart" in response.url.lower()
                or "power" in response.url.lower()
            ):
                responses.append(response.url)

        page.on("response", record_response)
        try:
            page.click(selector)
            sleep(2000)
        finally:
            page.remove_listener("response", record_response)
        for url in dict.fromkeys(responses):
            print("SEMS+ date-change API:", url)
        return

    with page.expect_response(
        lambda response: "/api/v2/Charts/GetPlantPowerChart" in response.url and response.request.method == "POST",
        timeout=30000,
    ):
        page.click(selector)
    sleep(1500)


def move_to_latest_date(page: Page, platform: str) -> date:
    right_selector = (
        '#chartBox [aria-label="caret-right"]'
        if platform == "plus"
        else ".station-date-picker_right"
    )
    while not is_right_button_disabled(page, platform):
        click_date_button(page, right_selector, platform)
    return get_current_page_date(page, platform)


def move_to_target_date(page: Page, latest_date: date, target_date: date, platform: str) -> date:
    offset = diff_days(latest_date, target_date)
    if offset < 0:
        raise RuntimeError(
            f"target date {format_ymd(target_date)} is newer than remote latest {format_ymd(latest_date)}"
        )

    current = get_current_page_date(page, platform)
    current_offset = diff_days(latest_date, current)
    remaining = offset - current_offset

    if remaining < 0:
        raise RuntimeError(
            f"current page date {format_ymd(current)} is already older than target {format_ymd(target_date)}"
        )

    for _ in range(remaining):
        left_selector = (
            '#chartBox [aria-label="caret-left"]'
            if platform == "plus"
            else ".station-date-picker_left"
        )
        click_date_button(page, left_selector, platform)

    current = get_current_page_date(page, platform)
    if format_ymd(current) != format_ymd(target_date):
        raise RuntimeError(
            f"failed to reach target date {format_ymd(target_date)}; current page date is {format_ymd(current)}"
        )

    return current


def export_current_date(page: Page, out_dir: Path, ymd: str, platform: str) -> Path:
    if platform == "plus":
        captured: list[dict[str, Any]] = []

        def capture_power_response(response: Any) -> None:
            if response.request.method != "POST":
                return
            try:
                response_json = response.json()
                data_lists = ((response_json.get("data") or {}).get("dataList"))
                if not isinstance(data_lists, list):
                    return

                try:
                    post_data = json.loads(response.request.post_data or "{}")
                except (TypeError, json.JSONDecodeError):
                    post_data = {"raw": response.request.post_data or ""}

                captured.append(
                    {
                        "url": response.url,
                        "post_data": post_data,
                        "response": response_json,
                    }
                )
            except Exception:
                return

        page.on("response", capture_power_response)
        try:
            right_selector = '#chartBox [aria-label="caret-right"]'
            left_selector = '#chartBox [aria-label="caret-left"]'
            if is_right_button_disabled(page, "plus"):
                page.click(left_selector)
                sleep(1500)
                page.click(right_selector)
            else:
                page.click(right_selector)
                sleep(1500)
                page.click(left_selector)
            sleep(2500)
        finally:
            page.remove_listener("response", capture_power_response)

        matching = next(
            (
                item
                for item in reversed(captured)
                if ymd in json.dumps(item["post_data"], default=str)
                or any(
                    str(point.get("tp") or "").startswith(ymd)
                    for series in ((item["response"].get("data") or {}).get("dataList") or [])
                    if isinstance(series, dict)
                    for point in (series.get("powerData") or [])
                    if isinstance(point, dict)
                )
            ),
            None,
        )
        # The date-change request for the requested day is the final request in
        # the toggle sequence. Some SEMS+ deployments omit the date from the
        # request body and return an empty series, so it cannot be matched by
        # timestamp; in that case use the last structurally valid response.
        if not matching and captured:
            matching = captured[-1]
        if not matching:
            raise RuntimeError(
                f"SEMS+ power response was not captured for {ymd}; "
                "no POST response contained data.dataList"
            )
        print(f"[{ymd}] Captured SEMS+ power API: {matching['url']}")
        response_json = matching["response"]
        if response_json.get("code") != "00000":
            raise RuntimeError(f"SEMS+ power API failed for {ymd}: {response_json}")

        out_path = out_dir / f"{ymd}_power.xls"
        write_sems_plus_workbook(out_path, "Calnext Testbed", response_json)
        print(f"[{ymd}] Saved SEMS+ power data to {out_path}")
        html_path = generate_chart_from_xls(out_path, ymd)
        print(f"[{ymd}] Generated chart at {html_path}")
        return out_path

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

    platform = os.environ.get("SEMS_PLATFORM", "plus").lower()
    if platform not in {"plus", "classic"}:
        raise RuntimeError("SEMS_PLATFORM must be either 'plus' or 'classic'")
    target_url = (
        SEMS_PLUS_URL
        if platform == "plus"
        else f"https://www.semsportal.com/powerstation/PowerStatusSnMin/{station_id}"
    )
    local_dates = list_local_dates(out_dir)

    with sync_playwright() as playwright:
        headless = os.environ.get("PLAYWRIGHT_HEADLESS", "").lower() in {"1", "true", "yes"}
        browser = playwright.chromium.launch(
            headless=headless,
            slow_mo=500 if not headless else 0,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1600, "height": 1000},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            login(page, username, password, platform)
            open_power_page(page, target_url, platform)

            latest_remote_date = move_to_latest_date(page, platform)
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
                move_to_target_date(page, latest_remote_date, target_date, platform)
                page_date = get_current_page_date(page, platform)
                print(f"[{ymd}] Page date is {format_ymd(page_date)} ({format_page_date(page_date)})")
                export_current_date(page, out_dir, ymd, platform)

            update_energy_page(out_dir)
            print("Done")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
