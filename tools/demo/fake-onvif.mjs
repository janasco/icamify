#!/usr/bin/env node
/**
 * Fake ONVIF Profile S camera, for the demo.
 *
 * It answers WS-Discovery probes on 239.255.255.250:3702 and speaks just enough
 * SOAP to exercise the real client in `@icamify/onvif`: capabilities, profiles,
 * stream URIs, presets and continuous PTZ moves. Every move is printed, so the
 * PTZ panel in the console can be verified against what the "camera" received.
 *
 * `node tools/demo/fake-onvif.mjs --port 8990 --user admin --password demo-password`
 */
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';

const options = parseArgs(process.argv.slice(2));
const port = options.port ?? 8990;
const host = '127.0.0.1';
const username = options.user ?? 'admin';
const password = options.password ?? 'demo-password';
const rtspBase = `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:8554`;

const state = {
  presets: [
    { token: '1', name: 'porch' },
    { token: '2', name: 'gate' },
    { token: '3', name: 'parking' },
  ],
  current: 'porch',
  moving: null,
  moves: 0,
  gotos: 0,
};

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const action = soaAction(request.headers.soapaction, body);
    if (action === undefined) {
      respond(response, 400, fault('ter:ActionNotSupported', 'Could not determine the SOAP action.'));
      return;
    }
    // GetSystemDateAndTime is the one operation ONVIF allows unauthenticated.
    if (action !== 'GetSystemDateAndTime' && !authorized(request.headers.authorization, body)) {
      response.writeHead(401, {
        'Content-Type': 'text/xml; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="onvif"',
      });
      response.end();
      return;
    }
    respond(response, 200, handle(action, body));
  });
});

server.listen(port, host, () => {
  log(`fake ONVIF camera on http://${host}:${port}/onvif/device_service (${username}/***)`);
});

// --- WS-Discovery responder --------------------------------------------------
const discovery = createSocket({ type: 'udp4', reuseAddr: true });
discovery.on('error', (error) => log(`discovery socket: ${error.message}`));
discovery.bind(3702, () => {
  try {
    discovery.addMembership('239.255.255.250');
    discovery.setMulticastLoopback(true);
  } catch (error) {
    log(`multicast join failed: ${error.message}`);
  }
  log('answering WS-Discovery probes on 239.255.255.250:3702');
});
discovery.on('message', (message, remote) => {
  const text = message.toString('utf8');
  if (!/Probe[^M]/.test(text) && !text.includes('</d:Probe>')) return;
  const probeId = /<[a-z]+:MessageID>([^<]*)<\/[a-z]+:MessageID>/i.exec(text)?.[1] ?? 'uuid:unknown';
  const reply =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>uuid:demo-${Date.now()}</w:MessageID>` +
    `<w:RelatesTo>${probeId}</w:RelatesTo>` +
    '<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</w:Action></e:Header>' +
    '<e:Body><d:ProbeMatches><d:ProbeMatch>' +
    `<w:EndpointReference><w:Address>urn:uuid:demo-onvif-${port}</w:Address></w:EndpointReference>` +
    `<w:Types>dn:NetworkVideoTransmitter</w:Types>` +
    `<w:Scopes>onvif://www.onvif.org/type/NetworkVideoTransmitter ` +
    'onvif://www.onvif.org/name/Porch%20PTZ ' +
    'onvif://www.onvif.org/hardware/Acme%20IPC-9000 ' +
    'onvif://www.onvif.org/location/Entrance</w:Scopes>' +
    `<w:XAddrs>http://${host}:${port}/onvif/device_service</w:XAddrs>` +
    `<w:MetadataVersion>1</w:MetadataVersion>` +
    '</d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>';
  discovery.send(Buffer.from(reply), remote.port, remote.address);
  log(`discovery: answered ${remote.address}:${remote.port}`);
});

function handle(action, body) {
  switch (action) {
    case 'GetSystemDateAndTime':
      return envelope(
        '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>' +
          '<tt:DateTimeType>Manual</tt:DateTimeType>' +
          `<tt:UTCDateTime>${nowXml()}</tt:UTCDateTime>` +
          '<tt:LocalDateTime><tt:DateTime>' +
          iso(new Date()).slice(19) +
          '</tt:DateTime></tt:LocalDateTime>' +
          '</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
      );
    case 'GetCapabilities':
      return envelope(
        '<tds:GetCapabilitiesResponse><tds:Capabilities>' +
          '<tt:Media><tt:XAddr>http://' +
          host +
          ':' +
          port +
          '/onvif/media_service</tt:XAddr>' +
          '<tt:StreamingCapabilities><tt:RTP_Multicast>false</tt:RTP_Multicast>' +
          '<tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP>' +
          '</tt:StreamingCapabilities><tt:Extension><tt:ProfileCapabilities>' +
          '<tt:MaximumNumberOfProfiles>4</tt:MaximumNumberOfProfiles>' +
          '</tt:ProfileCapabilities></tt:Extension></tt:Media>' +
          '<tt:PTZ><tt:XAddr>http://' +
          host +
          ':' +
          port +
          '/onvif/ptz_service</tt:XAddr></tt:PTZ>' +
          '<tt:Device><tt:XAddr>http://' +
          host +
          ':' +
          port +
          '/onvif/device_service</tt:XAddr>' +
          '<tt:Network><tt:IPFilter>false</tt:IPFilter></tt:Network>' +
          '</tt:Device>' +
          '</tds:Capabilities></tds:GetCapabilitiesResponse>',
      );
    case 'GetDeviceInformation':
      return envelope(
        '<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer>' +
          '<tds:Model>IPC-9000</tds:Model><tds:FirmwareVersion>2.4.1</tds:FirmwareVersion>' +
          '<tds:SerialNumber>DEMO-0001</tds:SerialNumber>' +
          '<tds:HardwareId>1</tds:HardwareId></tds:GetDeviceInformationResponse>',
      );
    case 'GetProfiles':
      return envelope(
        '<trt:GetProfilesResponse>' +
          profileXml('profile_main', 'main', 1920, 1080) +
          profileXml('profile_sub', 'sub', 640, 360) +
          '</trt:GetProfilesResponse>',
      );
    case 'GetStreamUri': {
      const token = /<(?:[\w.-]+:)?ProfileToken>([^<]+)</.exec(body)?.[1] ?? 'profile_main';
      const channel = token.includes('sub') ? 'ch2' : 'ch1';
      return envelope(
        '<trt:GetStreamUriResponse><trt:MediaUri>' +
          `<tt:Uri>${rtspBase}/${channel}</tt:Uri>` +
          '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>' +
          '<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>' +
          '<tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>',
      );
    }
    case 'GetSnapshotUri':
      return envelope(
        '<trt:GetSnapshotUriResponse><trt:MediaUri>' +
          `<tt:Uri>http://${host}:${port}/snapshot.jpg</tt:Uri>` +
          '<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>' +
          '<tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse>',
      );
    case 'GetServiceCapabilities':
      return envelope('<tptz:GetServiceCapabilitiesResponse><tptz:Capabilities/></tptz:GetServiceCapabilitiesResponse>');
    case 'GetNodes':
      return envelope(
        '<tptz:GetNodesResponse><tptz:PTZNode token="ptz_node">' +
          '<tt:Name>PTZ Node</tt:Name><tt:SupportedPTZSpaces>' +
          '<tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace>' +
          '<tt:ContinuousZoomVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange></tt:ContinuousZoomVelocitySpace>' +
          '</tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>8</tt:MaximumNumberOfPresets>' +
          '<tt:HomeSupported>false</tt:HomeSupported></tptz:PTZNode></tptz:GetNodesResponse>',
      );
    case 'GetConfigurations':
      return envelope(
        '<tptz:GetConfigurationsResponse><tptz:PTZConfiguration token="ptz_config">' +
          '<tt:Name>PTZ</tt:Name><tt:UseCount>1</tt:UseCount><tt:NodeToken>ptz_node</tt:NodeToken>' +
          '<tt:DefaultAbsolutePantTiltPositionSpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:DefaultAbsolutePantTiltPositionSpace>' +
          '<tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>' +
          '<tt:DefaultPTZSpeed><tt:PanTilt x="0.5" y="0.5"/><tt:Zoom x="0.5"/></tt:DefaultPTZSpeed>' +
          '<tt:DefaultPTZTimeout>PT5S</tt:DefaultPTZTimeout>' +
          '</tptz:PTZConfiguration></tptz:GetConfigurationsResponse>',
      );
    case 'ContinuousMove': {
      const pan = number(/<(?:[\w.-]+:)?PanTilt[^>]*x="([^"]*)"/.exec(body)?.[1]);
      const tilt = number(/<(?:[\w.-]+:)?PanTilt[^>]*y="([^"]*)"/.exec(body)?.[1]);
      const zoom = number(/<(?:[\w.-]+:)?Zoom[^>]*x="([^"]*)"/.exec(body)?.[1]);
      state.moving = { pan, tilt, zoom };
      state.moves += 1;
      log(`PTZ ContinuousMove pan=${pan} tilt=${tilt} zoom=${zoom}`);
      return envelope('<tptz:ContinuousMoveResponse/>');
    }
    case 'AbsoluteMove':
    case 'RelativeMove': {
      const pan = number(/<(?:[\w.-]+:)?PanTilt[^>]*x="([^"]*)"/.exec(body)?.[1]);
      const tilt = number(/<(?:[\w.-]+:)?PanTilt[^>]*y="([^"]*)"/.exec(body)?.[1]);
      state.moving = { pan, tilt, zoom: 0 };
      state.moves += 1;
      log(`PTZ ${action} pan=${pan} tilt=${tilt}`);
      return envelope(`<tptz:${action}Response/>`);
    }
    case 'Stop':
      log(`PTZ Stop (was ${JSON.stringify(state.moving)})`);
      state.moving = null;
      return envelope('<tptz:StopResponse/>');
    case 'GetStatus':
      return envelope(
        '<tptz:GetStatusResponse><tptz:PTZStatus>' +
          '<tt:Position><tt:PanTilt x="0" y="0"/><tt:Zoom x="0"/></tt:Position>' +
          '<tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus>' +
          '<tt:UtcTime>' +
          iso(new Date()) +
          '</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>',
      );
    case 'GetPresets':
      return envelope(`<tptz:GetPresetsResponse>${state.presets.map(presetXml).join('')}</tptz:GetPresetsResponse>`);
    case 'GetPreset': {
      const token = /<(?:[\w.-]+:)?PresetToken>([^<]+)</.exec(body)?.[1] ?? '';
      const preset = state.presets.find((candidate) => candidate.token === token);
      if (preset === undefined) return fault('ter:NoToken', `No preset ${token}.`);
      return envelope(`<tptz:GetPresetResponse>${presetXml(preset)}</tptz:GetPresetResponse>`);
    }
    case 'GotoPreset': {
      const token = /<(?:[\w.-]+:)?PresetToken>([^<]+)</.exec(body)?.[1] ?? '';
      const preset = state.presets.find((candidate) => candidate.token === token);
      if (preset === undefined) return fault('ter:NoToken', `No preset ${token}.`);
      state.current = preset.name;
      state.gotos += 1;
      log(`PTZ GotoPreset ${token} (${preset.name})`);
      return envelope('<tptz:GotoPresetResponse/>');
    }
    case 'SetPreset': {
      const name = /<(?:[\w.-]+:)?PresetName>([^<]*)</.exec(body)?.[1] ?? `preset-${state.presets.length + 1}`;
      const token = String(state.presets.length + 1);
      state.presets.push({ token, name });
      log(`PTZ SetPreset ${token} (${name})`);
      return envelope(`<tptz:SetPresetResponse><tptz:PresetToken>${token}</tptz:PresetToken></tptz:SetPresetResponse>`);
    }
    default:
      log(`unhandled SOAP action ${action}`);
      return fault('ter:ActionNotSupported', `The demo device does not implement ${action}.`);
  }
}

function profileXml(token, suffix, width, height) {
  return (
    `<trt:Profiles token="${token}" fixed="true">` +
    `<tt:Name>${suffix === 'main' ? 'Main stream' : 'Sub stream'}</tt:Name>` +
    `<tt:VideoSourceConfiguration token="vsc_${suffix}"><tt:Name>Video source ${suffix}</tt:Name>` +
    `<tt:UseCount>1</tt:UseCount><tt:SourceToken>vs_${suffix}</tt:SourceToken>` +
    `<tt:Bounds x="0" y="0" width="${width}" height="${height}"/></tt:VideoSourceConfiguration>` +
    `<tt:VideoEncoderConfiguration token="vec_${suffix}"><tt:Name>H264 ${suffix}</tt:Name>` +
    '<tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding>' +
    `<tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${height}</tt:Height></tt:Resolution>` +
    '<tt:Quality>5</tt:Quality>' +
    '<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>2048</tt:BitrateLimit></tt:RateControl>' +
    '<tt:H264><tt:GovLength>25</tt:GovLength><tt:H264Profile>Main</tt:H264Profile></tt:H264>' +
    '</tt:VideoEncoderConfiguration>' +
    '<tt:PTZConfiguration token="ptz_config"><tt:Name>PTZ</tt:Name><tt:UseCount>1</tt:UseCount>' +
    '<tt:NodeToken>ptz_node</tt:NodeToken>' +
    '<tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>' +
    '<tt:DefaultPTZTimeout>PT5S</tt:DefaultPTZTimeout></tt:PTZConfiguration>' +
    '</trt:Profiles>'
  );
}

function presetXml(preset) {
  // The ONVIF element is `Preset`, not `PTZPreset`; clients parse it by name.
  return (
    `<tptz:Preset token="${preset.token}"><tt:Name>${preset.name}</tt:Name>` +
    '<tt:PTZPosition><tt:PanTilt x="0" y="0"/><tt:Zoom x="0"/></tt:PTZPosition>' +
    '</tptz:Preset>'
  );
}

function soaAction(header, body) {
  // `SOAPAction: "http://www.onvif.org/ver10/media/wsdl/GetProfiles"` — quoted, so
  // the quotes have to come off before the last path segment is readable.
  if (typeof header === 'string') {
    const unquoted = header.trim().replace(/^"|"$/g, '');
    const fromHeader = /([A-Za-z0-9_]+)\s*$/.exec(unquoted)?.[1];
    if (fromHeader !== undefined) return fromHeader;
  }
  // Without the header, the operation is the first element inside the soap Body.
  const bodyStart = body.search(/<(?:[A-Za-z0-9]+:)?Body[\s>]/);
  const scoped = bodyStart === -1 ? body : body.slice(bodyStart);
  const fromBody = /<(?:[A-Za-z0-9]+:)?([A-Z][A-Za-z0-9]+)/.exec(scoped.replace(/<(?:[A-Za-z0-9]+:)?Body[\s>]/, ' '));
  return fromBody?.[1];
}

/** Accepts both Basic and a WS-Security UsernameToken, like a real camera. */
function authorized(header, body) {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  if (header === expected) return true;
  return body.includes(`<UsernameToken><Username>${username}</Username>`);
}

function respond(response, status, xml) {
  response.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' });
  response.end(xml);
}

function envelope(body) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
    'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

function fault(code, reason) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">' +
    '<SOAP-ENV:Body><SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Receiver</SOAP-ENV:Value>' +
    `<SOAP-ENV:Subcode><SOAP-ENV:Value>${code}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code>` +
    `<SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason>` +
    '</SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>'
  );
}

function nowXml() {
  const at = new Date();
  return (
    `<tt:Time><tt:Hour>${at.getUTCHours()}</tt:Hour><tt:Minute>${at.getUTCMinutes()}</tt:Minute>` +
    `<tt:Second>${at.getUTCSeconds()}</tt:Second></tt:Time>` +
    `<tt:Date><tt:Year>${at.getUTCFullYear()}</tt:Year><tt:Month>${at.getUTCMonth() + 1}</tt:Month>` +
    `<tt:Day>${at.getUTCDate()}</tt:Day></tt:Date>`
  );
}

function iso(date) {
  return date.toISOString().replace('Z', '+00:00');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function log(line) {
  process.stdout.write(`[onvif] ${line}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) continue;
    result[flag.slice(2)] = next;
    index += 1;
  }
  if (result.port !== undefined) result.port = Number(result.port);
  return result;
}
