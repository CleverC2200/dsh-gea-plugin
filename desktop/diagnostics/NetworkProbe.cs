using System;
using System.Collections.Generic;
using System.Net;

namespace GeaDiagnostics {
    internal sealed class TlsAttempt {
        public string protocol;
        public string result;
        public string innerErrorType;
        public string hresult;
    }
    internal static class NetworkProbe {
        static TlsAttempt Request(Uri uri, SecurityProtocolType protocol, string label) {
            ServicePointManager.SecurityProtocol = protocol;
            var attempt = new TlsAttempt { protocol = label };
            try {
                var request = (HttpWebRequest)WebRequest.Create(uri);
                request.Method = "HEAD"; request.Timeout = 3500; request.ReadWriteTimeout = 3500; request.AllowAutoRedirect = false;
                request.KeepAlive = false; request.ConnectionGroupName = Guid.NewGuid().ToString("N"); request.UseDefaultCredentials = false;
                using (var response = (HttpWebResponse)request.GetResponse()) attempt.result = "validated:http-" + (int)response.StatusCode;
            } catch (WebException error) {
                if (error.Response != null) { using (var response = (HttpWebResponse)error.Response) attempt.result = "validated:http-" + (int)response.StatusCode; }
                else {
                    attempt.result = error.Status.ToString();
                    attempt.innerErrorType = error.InnerException == null ? null : error.InnerException.GetType().Name;
                    attempt.hresult = "0x" + error.HResult.ToString("X8");
                }
            }
            return attempt;
        }
        internal static object Inspect(string host) {
            var original = ServicePointManager.SecurityProtocol;
            var attempts = new List<TlsAttempt>();
            bool dns = false;
            string proxyDescription = "unavailable";
            try {
                var resolution = Dns.GetHostAddressesAsync(host);
                dns = resolution.Wait(3000) && resolution.Result.Length > 0;
                var uri = new Uri("https://" + host);
                var proxy = WebRequest.GetSystemWebProxy();
                Uri endpoint = proxy.GetProxy(uri);
                proxyDescription = endpoint == null || endpoint.Host == host ? "direct" : endpoint.Scheme + "://" + endpoint.Host + ":" + endpoint.Port;
                attempts.Add(Request(uri, (SecurityProtocolType)0, "system-default"));
                if (!attempts[0].result.StartsWith("validated:", StringComparison.Ordinal)) attempts.Add(Request(uri, (SecurityProtocolType)3072, "tls12"));
            } catch (Exception error) {
                attempts.Add(new TlsAttempt { protocol = "discovery", result = error.GetType().Name, hresult = "0x" + error.HResult.ToString("X8") });
            } finally { ServicePointManager.SecurityProtocol = original; }
            return new { host = host, dns = dns, tls = attempts[attempts.Count - 1].result, systemProxy = proxyDescription, inheritedProtocol = original.ToString(), certificateValidation = "system-strict", credentialsSent = false, attempts = attempts };
        }
    }
}
