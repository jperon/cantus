# Web Worker — Verovio rendering
# Will be compiled and inlined as base64 Blob URL

tk = null

self.onmessage = (e) ->
  {type} = e.data
  try
    switch type
      when "init"
        self.postMessage { type: "ready" }

      when "load"
        self.postMessage { type: "loaded", pageCount: 0 }

      when "render"
        self.postMessage { type: "svg", page: e.data.page, svg: "<svg></svg>" }

  catch err
    self.postMessage { type: "error", message: err.message or String(err) }
