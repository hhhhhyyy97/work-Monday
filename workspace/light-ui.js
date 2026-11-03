// 忠实移植自 Lancer Light UI（MIT），去除 TypeScript 类型、合并为无构建的纯 JS。
// 来源：https://github.com/raylee-ai/lancer/tree/main/packages/light-ui
(function () {
  // ---- geometry ----
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const segment = (value, start, end) => clamp((value - start) / (end - start));
  const smoothstep = (value) => value * value * (3 - 2 * value);
  function cubicEase(x1, y1, x2, y2) {
    return (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let a = 0,
        b = 1,
        u = t;
      for (let i = 0; i < 22; i++) {
        u = (a + b) / 2;
        const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
        if (x < t) a = u;
        else b = u;
      }
      return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
    };
  }
  const FLIGHT_SECONDS = 1.2;
  const LANDING_SECONDS = 0.6;
  const flightEase = smoothstep;
  const outEase = cubicEase(0.16, 1, 0.3, 1);
  function bezier(a, c1, c2, b, p) {
    const q = 1 - p;
    return {
      x: q * q * q * a.x + 3 * q * q * p * c1.x + 3 * q * p * p * c2.x + p * p * p * b.x,
      y: q * q * q * a.y + 3 * q * q * p * c1.y + 3 * q * p * p * c2.y + p * p * p * b.y,
    };
  }
  const cubicPoint = (points, t) => bezier(...points, t);
  const cubicPath = ([a, c, d, b]) => `M ${a.x} ${a.y} C ${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`;
  function flightControls(a, b, seed) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const variant = Math.min(3, Math.floor(seed * 4));
    const variation = (seed * 4) % 1;
    const amplitude = Math.min(180, length * (0.14 + variation * 0.12));
    const direction = variant % 2 === 0 ? -1 : 1;
    const control = (fraction, bend) => ({
      x: Math.max(8, a.x + dx * fraction - (dy / length) * bend),
      y: Math.max(8, a.y + dy * fraction + (dx / length) * bend),
    });
    return [
      control(0.25 + variation * 0.1, direction * amplitude),
      control(0.65 + variation * 0.1, direction * amplitude * (variant < 2 ? 0.8 : -0.8)),
    ];
  }
  function arcLength(route, end) {
    let length = 0,
      previous = route.points[0];
    for (let i = 1; i <= 64; i++) {
      const next = cubicPoint(route.points, (end * i) / 64);
      length += Math.hypot(next.x - previous.x, next.y - previous.y);
      previous = next;
    }
    return length;
  }
  function flightGeometry(route) {
    const progress = route.progress ?? 0;
    const head = flightEase(progress);
    const tail = flightEase(segment(progress, 0.75, 1)) * 0.35;
    const a = cubicPoint(route.points, tail),
      b = cubicPoint(route.points, head);
    const start = arcLength(route, tail),
      end = arcLength(route, head),
      total = arcLength(route, 1);
    return {
      d: cubicPath(route.points),
      head,
      a,
      b,
      start,
      dash: `${Math.max(0, end - start)} ${total + 1}`,
      stops: [
        { offset: 0, "stop-color": route.color, "stop-opacity": 0 },
        { offset: 1, "stop-color": route.color },
      ],
    };
  }

  // ---- svg ----
  const NS = "http://www.w3.org/2000/svg";
  function svgElement(name, attrs = {}) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  }
  function renderRoute(route, serial) {
    const group = svgElement("g", { opacity: route.opacity });
    const d = cubicPath(route.points);
    const attrs = { d, fill: "none", stroke: route.color, "stroke-linecap": "round" };
    const path = svgElement("path", {
      ...attrs,
      "stroke-width": route.kind === "selection" ? (route.opacity === 0.75 ? 2.4 : 1.3) : 1.2,
      "data-curve-route": "true",
      "data-curve-id": route.id,
      "data-curve-event": route.eventId,
      "data-source-key": route.source,
      "data-target-key": route.target,
      "data-curve-kind": route.kind,
    });
    if (route.kind === "flight" && route.progress !== undefined) {
      const { head, a, b, start, dash, stops } = flightGeometry(route);
      const gradientId = `process-flight-${serial}`;
      const gradient = svgElement("linearGradient", {
        id: gradientId,
        gradientUnits: "userSpaceOnUse",
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      });
      gradient.append(...stops.map((stop) => svgElement("stop", stop)));
      group.append(gradient);
      for (const [width, opacity] of [
        [6, 0.07],
        [2.6, 0.13],
      ])
        group.append(
          svgElement("path", {
            ...attrs,
            "stroke-width": width,
            opacity: opacity,
            "stroke-dasharray": dash,
            "stroke-dashoffset": -start,
          }),
        );
      path.setAttribute("stroke", `url(#${gradientId})`);
      path.setAttribute("stroke-width", route.source.startsWith("family:") ? "2" : "1.3");
      path.setAttribute("stroke-dasharray", dash);
      path.setAttribute("stroke-dashoffset", String(-start));
      path.dataset.headProgress = String(head);
      if (route.source.startsWith("family:"))
        group.append(
          svgElement("circle", {
            cx: route.points[0].x,
            cy: route.points[0].y,
            r: 10,
            fill: "none",
            stroke: route.color,
            "stroke-width": 2,
            "data-flight-source": route.source,
          }),
        );
      group.append(
        path,
        svgElement("circle", { cx: b.x, cy: b.y, r: 6, fill: route.color, opacity: 0.16 }),
        svgElement("circle", {
          cx: b.x,
          cy: b.y,
          r: 2.2,
          fill: route.color,
          "data-flight-head": route.id,
        }),
      );
    } else {
      if (route.dashed) path.setAttribute("stroke-dasharray", route.kind === "retry" ? "2 2" : "4 4");
      group.append(path);
    }
    return group;
  }
  function updateFlight(group, route) {
    const { d, head, a, b, start, dash } = flightGeometry(route);
    group.setAttribute("opacity", String(route.opacity));
    for (const path of group.querySelectorAll("path")) {
      if (path.getAttribute("d") !== d) path.setAttribute("d", d);
      path.setAttribute("stroke-dasharray", dash);
      path.setAttribute("stroke-dashoffset", String(-start));
      if (path.hasAttribute("data-curve-route")) path.dataset.headProgress = String(head);
    }
    const gradient = group.querySelector("linearGradient");
    for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
      gradient.setAttribute(key, String(value));
    for (const circle of group.querySelectorAll("circle")) {
      if (circle.hasAttribute("data-flight-source")) {
        const launch = segment(route.progress ?? 0, 0, 0.55);
        circle.setAttribute("cx", String(route.points[0].x));
        circle.setAttribute("cy", String(route.points[0].y));
        circle.setAttribute("r", String(10 + launch * 8));
        circle.setAttribute("opacity", String((1 - launch) * 0.8));
        continue;
      }
      circle.setAttribute("cx", String(b.x));
      circle.setAttribute("cy", String(b.y));
    }
  }

  // ---- light layer ----
  let layerSerial = 0;
  function createLightLayer(root = document.body) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    if (!win) throw new Error("Light UI needs a mounted browser document.");
    const svg = svgElement("svg", { "aria-hidden": "true", "data-light-layer": "" });
    Object.assign(svg.style, {
      position: root === doc.body ? "fixed" : "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "10",
    });
    root.append(svg);
    const prefix = `light-${++layerSerial}`;
    const jobs = new Map();
    const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastTick = undefined;
    let paused = false;
    let destroyed = false;
    let serial = 0;
    const resolve = (job, result) => {
      if (job.resolved) return;
      job.resolved = true;
      job.resolve(result);
    };
    const remove = (id, result) => {
      const job = jobs.get(id);
      if (!job) return;
      resolve(job, result);
      job.group?.remove();
      job.ring?.remove();
      jobs.delete(id);
      if (!jobs.size) {
        win.cancelAnimationFrame(frame);
        frame = 0;
        lastTick = undefined;
      }
    };
    const point = (anchor, rect) => {
      const value = typeof anchor === "function" ? anchor() : anchor;
      if (!value) return null;
      let p;
      if ("getBoundingClientRect" in value) {
        if (!value.isConnected) return null;
        const bounds = value.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        p = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      } else p = value;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      return { x: p.x - rect.x, y: p.y - rect.y };
    };
    const draw = (now) => {
      frame = 0;
      if (destroyed || paused || doc.hidden) return;
      const delta = lastTick === undefined ? 0 : Math.max(0, now - lastTick);
      lastTick = now;
      const rect = svg.getBoundingClientRect();
      svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
      const anchors = new Map();
      for (const job of jobs.values())
        anchors.set(job, [point(job.flight.source, rect), point(job.flight.target, rect)]);
      for (const [id, job] of jobs) {
        const [a, b] = anchors.get(job);
        if (!a || !b) {
          remove(id, "missing-anchor");
          continue;
        }
        if (reduced.matches) {
          remove(id, "arrived");
          continue;
        }
        job.elapsed += delta;
        if (job.elapsed < job.duration) {
          const route = {
            id,
            eventId: id,
            source: job.flight.sourceKind === "model" ? `family:${id}` : `chat:${id}`,
            target: `tree:${id}`,
            kind: "flight",
            color: job.flight.color,
            opacity: 1,
            progress: job.elapsed / job.duration,
            points: [a, ...flightControls(a, b, job.seed), b],
          };
          if (job.group) updateFlight(job.group, route);
          else {
            job.group = renderRoute(route, `${prefix}-${++serial}`);
            svg.append(job.group);
          }
        } else {
          job.group?.remove();
          job.group = undefined;
          resolve(job, "arrived");
          const age = (job.elapsed - job.duration) / (LANDING_SECONDS * 1000);
          if (age >= 1) {
            remove(id, "arrived");
            continue;
          }
          const progress = outEase(age);
          if (!job.ring) {
            job.ring = svgElement("circle", {
              fill: "none",
              stroke: job.flight.color,
              "stroke-width": 1.2,
              "data-flight-landing": id,
            });
            svg.append(job.ring);
          }
          for (const [key, value] of Object.entries({
            cx: b.x,
            cy: b.y,
            r: 5 + progress * 20,
            opacity: (1 - progress) * 0.5,
          }))
            job.ring.setAttribute(key, String(value));
        }
      }
      schedule();
    };
    const schedule = () => {
      if (frame || !jobs.size || paused || doc.hidden || destroyed) return;
      frame = win.requestAnimationFrame(draw);
    };
    const suspend = () => {
      win.cancelAnimationFrame(frame);
      frame = 0;
      lastTick = undefined;
    };
    const visibility = () => {
      suspend();
      schedule();
    };
    doc.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", schedule);
    return {
      emit(flight) {
        if (destroyed) throw new Error("This light layer has been destroyed.");
        if (!flight.id || jobs.has(flight.id)) throw new Error("Use a unique event ID per flight.");
        if (jobs.size >= 128) throw new Error("Too many simultaneous flights; batch business events.");
        const duration = flight.duration ?? FLIGHT_SECONDS * 1000;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Duration must be positive.");
        const seed = flight.seed ?? Math.random();
        if (!Number.isFinite(seed) || seed < 0 || seed >= 1) throw new Error("Seed must be in [0, 1).");
        const finished = new Promise((resolveJob) => {
          jobs.set(flight.id, { flight, duration, seed, elapsed: 0, resolved: false, resolve: resolveJob });
        });
        schedule();
        return { finished, cancel: () => remove(flight.id, "cancelled") };
      },
      pause() {
        paused = true;
        suspend();
      },
      resume() {
        paused = false;
        schedule();
      },
      destroy() {
        destroyed = true;
        suspend();
        for (const id of jobs.keys()) remove(id, "cancelled");
        doc.removeEventListener("visibilitychange", visibility);
        reduced.removeEventListener("change", schedule);
        svg.remove();
      },
      get activeCount() {
        return jobs.size;
      },
      get paused() {
        return paused;
      },
    };
  }

  window.LightUI = { createLightLayer, svgElement, renderRoute, updateFlight };
})();
