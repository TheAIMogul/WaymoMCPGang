/**
 * Minimal protobuf wire codec for the Waymo RPCs used by the Cloudflare Worker MCP.
 * 1:1 port of src/waymo_mcp/wire.py (zero external dependencies).
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function varint(value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const out = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

export function readVarint(data, offset = 0) {
  let value = 0n;
  let shift = 0n;
  while (offset < data.length && shift < 70n) {
    const byte = data[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) {
      const signed = BigInt.asIntN(64, value);
      return [Number(signed), offset];
    }
    shift += 7n;
  }
  throw new Error("invalid protobuf varint");
}

export function key(field, wireType) {
  return varint((BigInt(field) << 3n) | BigInt(wireType));
}

export function message(field, value) {
  return concatBytes(key(field, 2), varint(value.length), value);
}

export function integer(field, value) {
  return concatBytes(key(field, 0), varint(value));
}

export function string(field, value) {
  return message(field, utf8Encoder.encode(value));
}

export function* iterFields(data) {
  let offset = 0;
  while (offset < data.length) {
    let tag;
    [tag, offset] = readVarint(data, offset);
    const uTag = BigInt.asUintN(64, BigInt(tag));
    const field = Number(uTag >> 3n);
    const wireType = Number(uTag & 7n);
    if (field <= 0) {
      throw new Error(`invalid protobuf field number ${field}`);
    }
    if (wireType === 0) {
      let value;
      [value, offset] = readVarint(data, offset);
      yield [field, wireType, value];
    } else if (wireType === 1) {
      const end = offset + 8;
      if (end > data.length) throw new Error("truncated fixed64 field");
      yield [field, wireType, data.subarray(offset, end)];
      offset = end;
    } else if (wireType === 2) {
      let length;
      [length, offset] = readVarint(data, offset);
      if (length < 0) throw new Error("negative length-delimited field");
      const end = offset + length;
      if (end > data.length) throw new Error("truncated length-delimited field");
      yield [field, wireType, data.subarray(offset, end)];
      offset = end;
    } else if (wireType === 5) {
      const end = offset + 4;
      if (end > data.length) throw new Error("truncated fixed32 field");
      yield [field, wireType, data.subarray(offset, end)];
      offset = end;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
}

export function bytesFields(data, targetField) {
  const out = [];
  for (const [number, wireType, value] of iterFields(data)) {
    if (number === targetField && wireType === 2 && value instanceof Uint8Array) {
      out.push(value);
    }
  }
  return out;
}

export function replaceMessages(data, replacements) {
  const chunks = [];
  for (const [field, wireType, value] of iterFields(data)) {
    if (Object.prototype.hasOwnProperty.call(replacements, field) && wireType === 2) {
      chunks.push(message(field, replacements[field]));
    } else if (wireType === 0) {
      chunks.push(integer(field, value));
    } else if (wireType === 1 || wireType === 5) {
      chunks.push(concatBytes(key(field, wireType), value));
    } else if (wireType === 2) {
      chunks.push(message(field, value));
    }
  }
  return concatBytes(...chunks);
}

export function replaceRepeatedMessages(data, fieldNumber, values) {
  const chunks = [];
  let inserted = false;
  for (const [field, wireType, value] of iterFields(data)) {
    if (field === fieldNumber && wireType === 2) {
      if (!inserted) {
        for (const replacement of values) {
          chunks.push(message(fieldNumber, replacement));
        }
        inserted = true;
      }
      continue;
    }
    if (wireType === 0) {
      chunks.push(integer(field, value));
    } else if (wireType === 1 || wireType === 5) {
      chunks.push(concatBytes(key(field, wireType), value));
    } else if (wireType === 2) {
      chunks.push(message(field, value));
    }
  }
  if (!inserted) {
    for (const replacement of values) {
      chunks.push(message(fieldNumber, replacement));
    }
  }
  return concatBytes(...chunks);
}

export function replaceInteger(data, fieldNumber, replacement) {
  const chunks = [];
  let replaced = false;
  for (const [field, wireType, value] of iterFields(data)) {
    if (field === fieldNumber && wireType === 0) {
      if (!replaced) {
        chunks.push(integer(fieldNumber, replacement));
        replaced = true;
      }
      continue;
    }
    if (wireType === 0) {
      chunks.push(integer(field, value));
    } else if (wireType === 1 || wireType === 5) {
      chunks.push(concatBytes(key(field, wireType), value));
    } else if (wireType === 2) {
      chunks.push(message(field, value));
    }
  }
  if (!replaced) {
    chunks.push(integer(fieldNumber, replacement));
  }
  return concatBytes(...chunks);
}

function isPrintableUtf8(bytes) {
  if (bytes.length === 0) return true;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false;
    if (b === 0x7f) return false;
  }
  try {
    strictUtf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function tryDecodeNested(bytes) {
  if (bytes.length === 0) return null;
  if (isPrintableUtf8(bytes)) return null;
  try {
    const fields = Array.from(iterFields(bytes));
    if (fields.length === 0) return null;
    for (const [field] of fields) {
      if (field <= 0 || field > 100000) return null;
    }
    return decodeFields(fields);
  } catch {
    return null;
  }
}

function decodeFields(fields) {
  const result = {};
  for (const [field, wireType, value] of fields) {
    const k = String(field);
    let decodedValue = value;
    if (wireType === 2 && value instanceof Uint8Array) {
      const nested = tryDecodeNested(value);
      decodedValue = nested !== null ? nested : value;
    }
    if (Object.prototype.hasOwnProperty.call(result, k)) {
      if (Array.isArray(result[k])) {
        result[k].push(decodedValue);
      } else {
        result[k] = [result[k], decodedValue];
      }
    } else {
      result[k] = decodedValue;
    }
  }
  return result;
}

export function decode(data) {
  if (!(data instanceof Uint8Array) || data.length === 0) return {};
  const fields = Array.from(iterFields(data));
  return decodeFields(fields);
}

export function text(value) {
  if (value instanceof Uint8Array) {
    return utf8Decoder.decode(value);
  }
  return typeof value === "string" ? value : "";
}

export function latLng(lat, lng) {
  return concatBytes(
    integer(1, Math.round(lat * 1e7)),
    integer(2, Math.round(lng * 1e7))
  );
}

export function namedLocation(query, lat, lng) {
  return concatBytes(
    message(1, latLng(lat, lng)),
    message(8, string(1, query))
  );
}

export class Place {
  constructor(name, address, latitude, longitude, placeId, ggq) {
    this.name = name;
    this.address = address;
    this.latitude = latitude;
    this.longitude = longitude;
    this.place_id = placeId ?? null;
    this._ggq = ggq;
  }

  public(index = null) {
    const result = {
      name: this.name,
      address: this.address,
      latitude: this.latitude,
      longitude: this.longitude,
      place_id: this.place_id,
    };
    if (index !== null && index !== undefined) {
      result.index = index;
    }
    return result;
  }
}

export function placeSearchRequest(query, biasLat, biasLng) {
  return concatBytes(
    message(2, namedLocation(query, biasLat, biasLng)),
    string(3, query),
    integer(5, 1)
  );
}

export function parsePlaces(response) {
  const places = [];
  for (const suggestion of bytesFields(response, 3)) {
    const locations = bytesFields(suggestion, 1);
    if (!locations.length) continue;
    const rawLocation = locations[0];
    const parsed = decode(rawLocation);
    if (!parsed || typeof parsed !== "object") continue;
    const coords = parsed["1"];
    const display = parsed["8"];
    if (!coords || typeof coords !== "object" || !display || typeof display !== "object") {
      continue;
    }
    const latRaw = Number(coords["1"]);
    const lngRaw = Number(coords["2"]);
    if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) continue;
    const latitude = latRaw * 1e-7;
    const longitude = lngRaw * 1e-7;
    let lines = display["2"] ?? [];
    if (!Array.isArray(lines)) lines = [lines];
    const address = lines.map((l) => text(l)).filter(Boolean).join(", ");
    const placeId = text(parsed["7"]) || text(parsed["4"]) || null;
    const name = text(display["1"]) || address;
    places.push(new Place(name, address, latitude, longitude, placeId, rawLocation));
  }
  return places;
}

function waypoint(place, uid) {
  return concatBytes(
    message(3, place._ggq),
    integer(7, 2),
    integer(9, uid)
  );
}

export function proposeTripRequest(
  pickup,
  dropoff,
  passengers = 1,
  {
    intermediateStops = [],
    scheduledOptionToken = null,
    planTemplate = null,
  } = {}
) {
  if (passengers < 1) throw new Error("passengers must be at least 1");
  if (intermediateStops.length > 3) throw new Error("at most 3 intermediate stops are supported");

  const places = [pickup, ...intermediateStops, dropoff];
  const firstUid = Date.now();
  const waypointUids = places.map((_, i) => firstUid + i);
  const passenger = integer(1, passengers);
  const legs = [];
  for (let i = 0; i < places.length - 1; i++) {
    legs.push(
      concatBytes(
        message(2, waypoint(places[i], waypointUids[i])),
        message(3, waypoint(places[i + 1], waypointUids[i + 1])),
        message(8, passenger)
      )
    );
  }

  let plan;
  if (planTemplate && planTemplate.length > 0) {
    const configurations = bytesFields(planTemplate, 3);
    const configuration = configurations.length
      ? replaceInteger(configurations[0], 1, passengers)
      : passenger;
    plan = replaceMessages(planTemplate, { 3: configuration });
    plan = replaceRepeatedMessages(plan, 5, legs);
  } else {
    const configuration = passenger;
    plan = concatBytes(integer(1, 1), message(3, configuration), ...legs.map((l) => message(5, l)));
  }

  let request = concatBytes(
    message(2, plan),
    integer(3, 1),
    integer(6, 7),
    integer(7, 1),
    integer(8, 0),
    integer(13, 1)
  );
  if (scheduledOptionToken) {
    request = concatBytes(request, string(10, scheduledOptionToken));
  }
  return request;
}

function parseMoney(data) {
  const currencies = bytesFields(data, 1);
  const amounts = bytesFields(data, 2);
  if (!currencies.length || !amounts.length) return null;
  const currency = utf8Decoder.decode(currencies[0]);
  const amount = utf8Decoder.decode(amounts[0]);
  if (currency === "USD" && /^\d+(?:\.\d+)?$/.test(amount) && Number(amount) >= 0) {
    return [currency, amount];
  }
  return null;
}

function parseScheduledOption(data) {
  const tokens = bytesFields(data, 1);
  if (!tokens.length) return null;
  const token = utf8Decoder.decode(tokens[0]);
  const times = bytesFields(data, 6);
  const labels = bytesFields(data, 7);
  const result = {
    token,
    label: times.length ? utf8Decoder.decode(times[0]) : null,
    subtitle: labels.length ? utf8Decoder.decode(labels[0]) : null,
    is_asap: token === "scheduled_trip_token_asap",
  };
  if (token.startsWith("timestamp_")) {
    const ts = Number(token.slice("timestamp_".length));
    if (Number.isFinite(ts) && ts > 0) {
      result.departure_time = new Date(ts * 1000).toISOString().replace(".000Z", "+00:00");
    }
  }
  return result;
}

export function parseQuote(response) {
  const offers = bytesFields(response, 3);
  if (!offers.length) throw new Error("Waymo returned no trip proposal");
  const offer = offers[0];
  const tokens = bytesFields(offer, 1);
  const token = tokens.length ? utf8Decoder.decode(tokens[0]) : "";
  if (!token) throw new Error("Waymo returned a proposal without a booking token");

  const prices = bytesFields(offer, 2);
  const standard = prices.length ? bytesFields(prices[0], 3) : [];
  const totals = standard.length ? bytesFields(standard[0], 1) : [];
  const estimatedTotal = totals.length ? parseMoney(totals[0]) : null;

  const scheduledOptions = [];
  for (const rawOption of bytesFields(offer, 9)) {
    const opt = parseScheduledOption(rawOption);
    if (opt !== null) scheduledOptions.push(opt);
  }

  return {
    proposal_token: token,
    estimated_fare: estimatedTotal ? `$${estimatedTotal[1]}` : null,
    scheduled_options: scheduledOptions,
  };
}

export function parseCancellationFee(data) {
  const pending = [data];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    const keyStr = Array.from(current.subarray(0, 64)).join(",") + ":" + current.length;
    if (seen.has(keyStr)) continue;
    seen.add(keyStr);

    const money = parseMoney(current);
    if (money) return `$${money[1]}`;

    let fields;
    try {
      fields = Array.from(iterFields(current));
    } catch {
      continue;
    }
    for (const [, wireType, value] of fields) {
      if (wireType !== 2 || !(value instanceof Uint8Array)) continue;
      let rendered = "";
      try {
        rendered = strictUtf8Decoder.decode(value);
      } catch {
        rendered = "";
      }
      const match = rendered.match(/\$\s*\d+(?:\.\d{2})?/);
      if (match) return match[0].replace(/\s+/g, "");
      pending.push(value);
    }
  }
  return null;
}

export function createTripRequest(proposalToken, paymentToken) {
  const payment = concatBytes(string(1, paymentToken), integer(3, 3));
  return concatBytes(string(8, proposalToken), integer(5, 1), message(12, payment));
}

export function cancelTripRequest(cancellationToken) {
  return concatBytes(integer(3, 7), string(4, cancellationToken));
}

