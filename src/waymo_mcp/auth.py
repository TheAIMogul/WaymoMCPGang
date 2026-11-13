"""Authentication for the private Waymo rider API."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

OAUTH_CLIENT_ID = "936475272427.apps.googleusercontent.com"
WAYMO_CLIENT_ID = "431988300665-qr3bvhc24trr8i3bb7laavu4qrs5on1r"
ANDROID_APP_ID = "com.waymo.carapp"
ANDROID_APP_SIG = "8cb0740811e55b4b260c8c62fc09283dfb47c484"
ANDROID_AUTH_SCOPES = "oauth2:https://www.googleapis.com/auth/chauffeur/hail"
FULL_SCOPES = (
    "https://www.googleapis.com/auth/cclog "
    "https://www.googleapis.com/auth/chauffeur/hail "
    "https://www.googleapis.com/auth/experimentsandconfigs "
    "profile email "
    "https://www.googleapis.com/auth/supportcontent "
    "https://www.googleapis.com/auth/account_settings_mobile"
)
USER_AGENT = (
    "com.waymo.client/2.3.26081700 iSL/3.4 "
    "iPhone/26.6.1 hw/iPhone17_4 (gzip)"
)
DEFAULT_DEVICE_ID = "F33B57DB-8668-40AD-A34E-9B2E0EE84F78"


@dataclass(frozen=True)
class Credentials:
    refresh_token: str
    device_id: str = DEFAULT_DEVICE_ID
    account_name: str = ""
    home_latitude: float | None = None
    home_longitude: float | None = None


def _post_form(
    url: str,
    data: dict[str, str],
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
            **(headers or {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"Authentication failed ({exc.code}): {detail}") from exc


def _post_form_lines(
    url: str,
    data: dict[str, str],
    headers: dict[str, str] | None = None,
) -> dict[str, str]:
    """POST a form and parse a key=value line response."""
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/plain",
            "User-Agent": USER_AGENT,
            **(headers or {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"Authentication failed ({exc.code}): {detail}") from exc
    fields: dict[str, str] = {}
    for line in body.strip().splitlines():
        key, separator, value = line.partition("=")
        if separator:
            fields[key] = value
    return fields


def _authenticate_android_master(credentials: Credentials) -> dict[str, Any]:
    """Mint a chauffeur-scoped access token from an aas_et master token.

    The master token is the device-level Google credential used by Google
    Play Services. Exchanging it for an app-scoped access token mirrors
    what GoogleAuthUtil does inside the Android app.
    """
    if not credentials.account_name:
        raise ValueError(
            "account_name is required when using an aas_et master token"
        )
    fields = _post_form_lines(
        "https://android.clients.google.com/auth",
        {
            "account_name": credentials.account_name,
            "Token": credentials.refresh_token,
            "app": ANDROID_APP_ID,
            "client_sig": ANDROID_APP_SIG,
            "service": ANDROID_AUTH_SCOPES,
            "device_country": "us",
            "operatorCountryType": "home",
            "simCountryType": "home",
            "lang": "en-US",
            "sdk_version": "34",
            "google_play_services_version": "231818037",
            "device": "Pixel 6",
        },
    )
    token = fields.get("Auth")
    if not token:
        error = fields.get("Error", fields)
        raise RuntimeError(f"Android authentication failed: {error}")
    try:
        expires_at = int(fields.get("Expiry", 0)) or int(time.time()) + 3600
    except ValueError:
        expires_at = int(time.time()) + 3600
    return {"chauffeur_token": token, "expires_at": expires_at}


def authenticate(credentials: Credentials) -> dict[str, Any]:
    if credentials.refresh_token.startswith("aas_et/"):
        return _authenticate_android_master(credentials)
    oauth = _post_form(
        "https://oauth2.googleapis.com/token",
        {
            "client_id": OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": credentials.refresh_token,
        },
    )
    chauffeur = _post_form(
        "https://oauthaccountmanager.googleapis.com/v1/issuetoken",
        {
            "app_id": "com.waymo.client",
            "client_id": WAYMO_CLIENT_ID,
            "device_id": credentials.device_id,
            "hl": "en-US",
            "lib_ver": "3.4",
            "response_type": "token",
            "scope": FULL_SCOPES,
        },
        {
            "Authorization": f"Bearer {oauth['access_token']}",
            "X-OAuth-Client-ID": WAYMO_CLIENT_ID,
        },
    )
    return {
        "chauffeur_token": chauffeur["token"],
        "expires_at": int(time.time()) + int(chauffeur.get("expiresIn", 3600)),
    }


def load_credentials(path: str | Path) -> Credentials:
    data = json.loads(Path(path).expanduser().read_text())
    token = data.get("refresh_token")
    if not token:
        raise ValueError(f"No refresh_token in {path}")
    return Credentials(
        token,
        data.get("device_id", DEFAULT_DEVICE_ID),
        data.get("account_name", ""),
        _optional_float(data.get("home_latitude")),
        _optional_float(data.get("home_longitude")),
    )


def _optional_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None
