// Injected first in <head> of the benchmark copy of renderer/index.html.
// Collects script errors (the smoke:ui criterion) and, once the page has
// loaded, reports the second animation frame: FIRST_FRAME <errors JSON>.
(function () {
  var errors = [];
  window.addEventListener("error", function (e) { errors.push(String(e.message || e.error || e).slice(0, 200)); });
  window.addEventListener("unhandledrejection", function (e) { errors.push("unhandled: " + String(e.reason && e.reason.message || e.reason).slice(0, 200)); });
  window.addEventListener("load", function () {
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var payload = JSON.stringify(errors);
      if (window.mygo && window.mygo.call) window.mygo.call("Bench.FirstFrame", payload);
      else console.log("FIRST_FRAME " + payload);
    }); });
  });
})();
