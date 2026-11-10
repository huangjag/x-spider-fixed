use std::collections::HashMap;
use reqwest::Method;
use serde_json::Value;

#[derive(Default, serde::Serialize)]
pub struct Response {
  status: u16,
  headers: HashMap<String, Vec<String>>,
  body: Value,
}

#[tauri::command]
pub async fn network_fetch(
  method: String,
  url: String,
  body: String,
  enable_proxy: bool,
  proxy_url: String,
  response_type: String,
  headers: HashMap<String, String>,
) -> Result<Response, String> {
  let map_reqwest_err = |err: reqwest::Error| err.to_string();
  // Convert method string into Method
  let method: Method = match method.to_uppercase().as_str() {
    "GET" => Ok(Method::GET),
    "POST" => Ok(Method::POST),
    "PATCH" => Ok(Method::PATCH),
    "PUT" => Ok(Method::PUT),
    "DELETE" => Ok(Method::DELETE),
    "HEAD" => Ok(Method::HEAD),
    _ => Err("Invalid method".to_string()),
  }?;

  // Build client
  let client = {
    let mut b = reqwest::Client::builder();

    // Auto set proxy settings
    if enable_proxy {
      if proxy_url.len() == 0 {
        // Use system proxy, do nothing
      } else {
        // Use custom proxy url
        let proxy_http = reqwest::Proxy::http(proxy_url.clone()).or(Err("Failed to set proxy url".to_string()))?;
        let proxy_https = reqwest::Proxy::https(proxy_url.clone()).or(Err("Failed to set proxy url".to_string()))?;
        b = b.proxy(proxy_http).proxy(proxy_https);
      }
    } else {
      // No proxy
      b = b.no_proxy();
    }

    b.build().or(Err("Failed to build reqwest client".to_string()))
  }?;

  // Build request
  let request = {
    let mut req = client.request(method.clone(), url);
    for (k, v) in headers {
      req = req.header(k, v);
    }

    if !matches!(method.clone(), Method::GET) {
      req = req.body(body);
    }

    req
  };

  // Send request
  let response = request.send().await.map_err(map_reqwest_err)?;

  // Extract some info
  let status = response.status().as_u16();
  let resp_headers = {
    let reqwest_headers = response.headers();
    let mut h: HashMap<String, Vec<String>> = HashMap::with_capacity(reqwest_headers.len());

    for (k, v) in reqwest_headers {
      let v = v.to_str();
      if let Err(_) = v {
        continue;
      }

      let v = v.unwrap().to_string();
      h.entry(k.to_string()).and_modify(|arr: &mut Vec<String>| arr.push(v.clone()))
        .or_insert_with(|| vec![v]);
    }

    h
  };

  // Load response body
  let body: Value = {
    match response_type.as_str() {
      "json" => response.json().await.map_err(map_reqwest_err).map(|res| Value::Object(res)),
      "text" => response.text().await.map_err(map_reqwest_err).map(|res| Value::String(res)),
      "binary" => {
        let bytes = response.bytes().await.map_err(map_reqwest_err)?;
        serde_json::to_value(bytes.to_vec()).map_err(|err| err.to_string())
      },
      _ => Err("Unsupported response type".to_string())
    }
  }?;

  return Ok(Response {
    status,
    body,
    headers: resp_headers })
}

#[tauri::command]
pub async fn network_get_system_proxy_url() -> Result<HashMap<String, String>, ()> {
  let mut proxies: HashMap<String, String> = HashMap::new();

  for (scheme, keys) in [
    ("https", ["HTTPS_PROXY", "https_proxy"]),
    ("http", ["HTTP_PROXY", "http_proxy"]),
  ] {
    for key in keys {
      if let Ok(value) = std::env::var(key) {
        if !value.trim().is_empty() {
          proxies.insert(scheme.to_string(), proxy_authority(&value));
          break;
        }
      }
    }
  }

  #[cfg(windows)]
  if proxies.is_empty() {
    if let Some(map) = read_windows_system_proxy() {
      proxies = map;
    }
  }

  Ok(proxies)
}

fn proxy_authority(value: &str) -> String {
  let value = value.trim();
  let value = value.split("://").last().unwrap_or(value);
  value.trim_end_matches('/').to_string()
}

#[cfg(windows)]
fn read_windows_system_proxy() -> Option<HashMap<String, String>> {
  use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
  use winreg::RegKey;

  let key = RegKey::predef(HKEY_CURRENT_USER)
    .open_subkey_with_flags(
      "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      KEY_READ,
    )
    .ok()?;

  if key.get_value::<u32, _>("ProxyEnable").ok()? == 0 {
    return Some(HashMap::new());
  }
  let server: String = key.get_value("ProxyServer").ok()?;
  Some(parse_proxy_server(&server))
}

#[cfg(windows)]
fn parse_proxy_server(server: &str) -> HashMap<String, String> {
  let mut map = HashMap::new();
  let server = server.trim();
  if server.is_empty() {
    return map;
  }
  if server.contains('=') {
    for part in server.split(';') {
      if let Some((proto, addr)) = part.split_once('=') {
        let proto = proto.trim().to_lowercase();
        let addr = addr.trim();
        if (proto == "http" || proto == "https") && !addr.is_empty() {
          map.insert(proto, addr.to_string());
        }
      }
    }
  } else {
    map.insert("http".to_string(), server.to_string());
    map.insert("https".to_string(), server.to_string());
  }
  map
}
