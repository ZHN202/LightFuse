(() => {
  'use strict';

  const degrees = Math.PI / 180;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const lightingURL = new URL('./static/lighting/environments.json', document.baseURI);
  const lightingMaps = new Map();
  let lightingCatalog;

  function loadLightingCatalog() {
    if (!lightingCatalog) {
      lightingCatalog = fetch(lightingURL).then(async response => {
        if (!response.ok) throw new Error();
        const catalog = await response.json();
        if (!catalog.environments?.length || catalog.width < 1 || catalog.height < 1 || catalog.roughness.length < 2) {
          throw new Error();
        }
        return catalog;
      }).catch(error => { lightingCatalog = null; throw error; });
    }
    return lightingCatalog;
  }

  function loadLightingMap(catalog, preset) {
    if (!lightingMaps.has(preset.file)) {
      const pending = fetch(new URL(preset.file, lightingURL)).then(async response => {
        if (!response.ok) throw new Error();
        const pixels = new Float32Array(await response.arrayBuffer());
        const layers = 1 + catalog.roughness.length;
        if (pixels.length !== catalog.width * catalog.height * layers * 3) throw new Error();
        return {width: catalog.width, height: catalog.height, layers, pixels};
      }).catch(error => { lightingMaps.delete(preset.file); throw error; });
      lightingMaps.set(preset.file, pending);
    }
    return lightingMaps.get(preset.file);
  }

  // An instance is one learned surfel. U and V contain one standard deviation
  // along its two tangent directions in the same world coordinates as its center.
  const vertexShader = `#version 300 es
    precision highp float;
    precision highp int;
    layout(location=0) in vec2 cornerUV;
    layout(location=1) in uint primitiveId;
    uniform highp sampler2D primitives;
    uniform highp sampler2DArray environment;
    uniform vec3 center, right, up, forward;
    uniform float radius, distanceToCenter, focal, aspect, azimuth, support;
    uniform int channel;
    out vec2 localUV;
    flat out vec3 rgb;
    flat out float opacity;

    vec2 environmentUV(vec3 dir) {
      // Inverse-rotate the lookup so the light revolves around the object.
      float c = cos(azimuth), s = sin(azimuth);
      vec2 xz = vec2(c * dir.x - s * dir.z, s * dir.x + c * dir.z);
      return vec2(0.5 + atan(xz.y, xz.x) / 6.2831853, acos(clamp(dir.y, -1.0, 1.0)) / 3.14159265);
    }

    vec3 shadeEnvironment(vec3 n, vec3 eye, vec3 srgb, float roughness, float metallic) {
      float nv = clamp(dot(n, eye), 0.0, 1.0);
      vec3 albedo = mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, srgb));
      vec3 f0 = mix(vec3(0.04), albedo, metallic);
      vec3 fresnel = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - nv, 5.0);
      vec3 diffuse = textureLod(environment, vec3(environmentUV(n), 0.0), 0.0).rgb
                   * albedo * (1.0 - metallic) * (1.0 - fresnel);

      // Split-sum GGX: interpolate the prefiltered radiance in roughness and
      // use the analytic environment BRDF approximation for its A/B factors.
      vec2 uv = environmentUV(reflect(-eye, n));
      float last = float(textureSize(environment, 0).z - 1);
      float layer = 1.0 + roughness * (last - 1.0);
      vec3 reflected = mix(textureLod(environment, vec3(uv, floor(layer)), 0.0).rgb,
                           textureLod(environment, vec3(uv, min(ceil(layer), last)), 0.0).rgb, fract(layer));
      vec4 fit = vec4(-1.0, -0.0275, -0.572, 0.022) * roughness + vec4(1.0, 0.0425, 1.04, -0.04);
      float a = min(fit.x * fit.x, exp2(-9.28 * nv)) * fit.x + fit.y;
      vec2 brdf = vec2(-1.04, 1.04) * a + fit.zw;
      vec3 linear = max(diffuse + reflected * max(f0 * brdf.x + brdf.y, vec3(0.0)), vec3(0.0));
      float peak = max(linear.r, max(linear.g, linear.b));
      if (peak > 0.7) {
        float excess = peak - 0.7;
        linear *= (0.7 + 0.3 * excess / (excess + 0.3)) / peak;
      }
      return clamp(mix(12.92 * linear, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055,
                       step(0.0031308, linear)), 0.0, 1.0);
    }

    void main() {
      int index = int(primitiveId) * 4;
      int width = textureSize(primitives, 0).x;
      ivec2 cell = ivec2(index % width, index / width);
      vec4 mean = texelFetch(primitives, cell, 0);
      vec4 u = texelFetch(primitives, cell + ivec2(1,0), 0);
      vec4 v = texelFetch(primitives, cell + ivec2(2,0), 0);
      vec3 color = texelFetch(primitives, cell + ivec2(3,0), 0).rgb;
      // The native tracer truncates a surfel where its effective opacity
      // falls below 0.01. The footprint inspection clips it to one sigma.
      float extent = min(support, sqrt(2.0 * log(max(1.0, mean.w / 0.01))));
      localUV = extent * cornerUV;
      vec3 p = (mean.xyz - center) / radius;
      vec3 corner = p + (localUV.x * u.xyz + localUV.y * v.xyz) / radius;
      float depth = distanceToCenter - dot(corner, forward);
      gl_Position = vec4(dot(corner, right) * focal / aspect, dot(corner, up) * focal,
                         1.000834 * depth - 0.020008, depth);
      opacity = mean.w;
      rgb = color;
      vec3 n = normalize(cross(normalize(u.xyz), normalize(v.xyz)));
      vec3 eye = normalize(distanceToCenter * forward - p);
      // The native tracer orients each two-sided surfel toward the incoming camera ray.
      if (dot(n, eye) < 0.0) n = -n;
      if (channel == 6) {
        rgb = shadeEnvironment(n, eye, color, u.w, v.w);
      } else if (channel == 1) {
        // A two-sided studio key and fill for interactive material inspection.
        vec3 light = normalize(vec3(sin(azimuth), 0.85, cos(azimuth)));
        vec3 halfVector = normalize(light + eye);
        float diffuse = max(dot(n, light), 0.0);
        float roughness = clamp(u.w, 0.06, 1.0);
        float metallic = v.w;
        vec3 albedo = pow(color, vec3(2.2));
        vec3 reflectance = mix(vec3(0.04), albedo, metallic);
        float gloss = mix(140.0, 3.0, roughness * roughness);
        vec3 key = albedo * (1.0 - metallic) * diffuse +
                   reflectance * pow(max(dot(halfVector, n), 0.0), gloss) * min(5.0, 0.2 * gloss) * diffuse;
        vec3 fill = albedo * (0.38 + 0.07 * n.y) + reflectance * 0.12;
        rgb = pow(clamp(key + fill, 0.0, 1.0), vec3(1.0 / 2.2));
      } else if (channel == 2) {
        vec3 viewNormal = vec3(dot(n, right), dot(n, up), dot(n, forward));
        rgb = 0.5 * viewNormal + 0.5;
      } else if (channel == 3 || channel == 4) {
        rgb = vec3(channel == 3 ? u.w : v.w);
      } else if (channel == 5) {
        // ID color makes adjacent one-sigma footprints distinguishable.
        uint hash = primitiveId * 1664525u + 1013904223u;
        rgb = vec3(0.24) + 0.7 * vec3(hash & 255u, (hash >> 8u) & 255u, (hash >> 16u) & 255u) / 255.0;
      }
    }`;

  const fragmentShader = `#version 300 es
    precision highp float;
    precision highp int;
    in vec2 localUV;
    flat in vec3 rgb;
    flat in float opacity;
    uniform int channel;
    uniform float support;
    out vec4 result;
    void main() {
      // Perspective-correct interpolation on the planar quad gives the local
      // coordinates of the camera ray's intersection with this Gaussian.
      float r2 = dot(localUV, localUV);
      if (r2 > support * support) discard;
      float alpha = min(0.99, opacity * exp(-0.5 * r2));
      if (alpha < 0.01) discard;
      vec3 color = rgb;
      if (channel == 5) {
        float edge = smoothstep(0.78, 1.0, r2);
        color = mix(rgb, vec3(0.04), edge);
      }
      result = vec4(alpha * color, alpha);
    }`;

  function compileProgram(gl, vertexSource, fragmentSource) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        gl.deleteProgram(program);
        throw new Error('This browser could not prepare the Gaussian shaders.');
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      throw new Error('This browser could not prepare the Gaussian renderer.');
    }
    return program;
  }

  // Blend encoded normals using the same visibility weights as the color pass.
  // Normalizing each pixel after blending keeps it a direction even on curved surfaces.
  function createNormalPass(gl) {
    const program = compileProgram(gl, `#version 300 es
      layout(location=0) in vec2 corner;
      void main() { gl_Position = vec4(corner, 0.0, 1.0); }`, `#version 300 es
      precision highp float;
      uniform highp sampler2D accumulated;
      out vec4 result;
      void main() {
        vec4 sampleValue = texelFetch(accumulated, ivec2(gl_FragCoord.xy), 0);
        float coverage = sampleValue.a;
        vec3 sum = 2.0 * sampleValue.rgb - coverage;
        float magnitude = length(sum);
        vec3 normal = magnitude > 1e-7 ? sum / magnitude : vec3(0.0);
        result = vec4((normal * 0.5 + 0.5) * coverage, coverage);
      }`);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'accumulated'), 2);
    const floating = !!gl.getExtension('EXT_color_buffer_float');
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    let width = 0, height = 0;
    return {
      bind(w, h) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        if (width === w && height === h) return;
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, floating ? gl.RGBA16F : gl.RGBA8, w, h, 0,
                      gl.RGBA, floating ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
        width = w;
        height = h;
      },
      resolve() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(program);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.enable(gl.BLEND);
      },
      dispose() {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      }
    };
  }

  // LFG1: a 16-byte header followed by 48-byte records. Geometry and opacity
  // retain their original float precision; colors and material scalars use unorm8.
  function readGaussians(bytes) {
    const data = new DataView(bytes);
    if (data.byteLength < 16 || data.getUint32(0) !== 0x4c464731) {
      throw new Error('This file is not a LightFuse Gaussian model.');
    }
    const count = data.getUint32(4, true);
    const stride = data.getUint32(8, true);
    if (!count || stride !== 48 || data.byteLength !== 16 + count * stride) {
      throw new Error('The Gaussian model file is incomplete.');
    }
    // Four RGBA float texels per primitive. The row width is a multiple of
    // four so that even the last record in a row occupies contiguous texels.
    const width = Math.min(count * 4, 1024);
    const height = Math.ceil(count * 4 / width);
    const texels = new Float32Array(width * height * 4);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let largestAxis = 0;
    for (let i = 0; i < count; i++) {
      const offset = 16 + i * stride;
      const texel = i * 16;
      for (let axis = 0; axis < 3; axis++) {
        const p = data.getFloat32(offset + 4 * axis, true);
        const u = data.getFloat32(offset + 12 + 4 * axis, true);
        const v = data.getFloat32(offset + 24 + 4 * axis, true);
        if (!Number.isFinite(p) || !Number.isFinite(u) || !Number.isFinite(v)) {
          throw new Error('The Gaussian model contains invalid geometry.');
        }
        min[axis] = Math.min(min[axis], p);
        max[axis] = Math.max(max[axis], p);
        largestAxis = Math.max(largestAxis, Math.hypot(u, v));
        texels[texel + axis] = p;
        texels[texel + 4 + axis] = u;
        texels[texel + 8 + axis] = v;
        texels[texel + 12 + axis] = data.getUint8(offset + 40 + axis) / 255;
      }
      const opacity = data.getFloat32(offset + 36, true);
      if (!(opacity >= 0 && opacity <= 1)) throw new Error('The model contains an invalid opacity.');
      texels[texel + 3] = opacity;
      texels[texel + 7] = data.getUint8(offset + 43) / 255;
      texels[texel + 11] = data.getUint8(offset + 44) / 255;
    }
    const center = min.map((value, axis) => (value + max[axis]) / 2);
    const radius = Math.max(Math.hypot(...max.map((v, axis) => v - center[axis])), 3 * largestAxis);
    if (radius <= 0) throw new Error('The Gaussian model has no visible extent.');
    return {count, texels, width, height, center, radius};
  }

  // Back-to-front order changes only when the orbit direction changes. Radix
  // sorting the float depth keys avoids copying the Gaussian records every drag.
  function makeDepthSorter(model, center) {
    const order = new Uint32Array(model.count);
    const scratch = new Uint32Array(model.count);
    const depths = new Float32Array(model.count);
    const keys = new Uint32Array(depths.buffer);
    const bins = new Uint32Array(256);
    return (x, y, z) => {
      for (let i = 0; i < model.count; i++) {
        const start = i * 16;
        depths[i] = x * (model.texels[start] - center[0]) +
                    y * (model.texels[start + 1] - center[1]) +
                    z * (model.texels[start + 2] - center[2]);
        const bits = keys[i];
        // Flip positive signs and reverse negative bit patterns so ascending
        // unsigned keys match ascending signed floats (farthest centers first).
        keys[i] = bits ^ (bits >>> 31 ? 0xffffffff : 0x80000000);
        order[i] = i;
      }
      let source = order, target = scratch;
      for (let shift = 0; shift < 32; shift += 8) {
        bins.fill(0);
        for (let i = 0; i < source.length; i++) bins[(keys[source[i]] >>> shift) & 255]++;
        let start = 0;
        for (let bucket = 0; bucket < bins.length; bucket++) {
          const length = bins[bucket];
          bins[bucket] = start;
          start += length;
        }
        for (let i = 0; i < source.length; i++) {
          const id = source[i];
          target[bins[(keys[id] >>> shift) & 255]++] = id;
        }
        [source, target] = [target, source];
      }
      return source;
    };
  }

  function mountRenderer(canvas, model, settings, onContextLoss) {
    const gl = canvas.getContext('webgl2', {alpha: true, antialias: true, depth: false, premultipliedAlpha: true});
    if (!gl) throw new Error('This browser needs WebGL 2 to render the Gaussian model.');
    const program = compileProgram(gl, vertexShader, fragmentShader);
    gl.useProgram(program);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, model.width, model.height, 0, gl.RGBA, gl.FLOAT, model.texels);
    gl.uniform1i(gl.getUniformLocation(program, 'primitives'), 0);

    const lighting = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, lighting);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Keep the sampler complete when the optional lighting files are unavailable.
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGB16F, 1, 1, 2, 0, gl.RGB, gl.FLOAT, null);
    gl.uniform1i(gl.getUniformLocation(program, 'environment'), 1);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, model.count * 4, gl.DYNAMIC_DRAW);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);
    const uniforms = {};
    for (const name of ['center', 'radius', 'right', 'up', 'forward', 'distanceToCenter',
      'focal', 'aspect', 'channel', 'azimuth', 'support']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    // An optional framing sphere keeps sparse outliers from shrinking the object.
    const target = settings.target?.split(',').map(value => value.trim() ? Number(value) : NaN);
    const center = target?.length === 3 && target.every(Number.isFinite) ? target : model.center;
    const radius = Number(settings.radius);
    gl.uniform3fv(uniforms.center, center);
    gl.uniform1f(uniforms.radius, radius > 0 && Number.isFinite(radius) ? radius : model.radius);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    const sort = makeDepthSorter(model, center);
    let sortedYaw, sortedPitch;
    const focal = 1 / Math.tan(22.5 * degrees);
    const initialYaw = Number(settings.yaw ?? 30) * degrees;
    const initialPitch = Number(settings.pitch ?? 22) * degrees;
    const initialZoom = Number(settings.zoom) || 1;
    let yaw = initialYaw;
    let pitch = initialPitch;
    let zoom = initialZoom;
    let channel = 1;
    let azimuth = 45;
    let frame = 0;
    let normalPass;
    function draw() {
      frame = 0;
      if (!canvas.clientWidth || !canvas.clientHeight) return;
      const pixelRatio = Math.min(devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const aspect = width / height;
      const distance = Math.hypot(1, focal / Math.min(1, aspect)) * 1.06 / zoom;
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const sp = Math.sin(pitch), cp = Math.cos(pitch);
      if (sortedYaw !== yaw || sortedPitch !== pitch) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, sort(cp * sy, sp, cp * cy));
        sortedYaw = yaw;
        sortedPitch = pitch;
      }
      gl.viewport(0, 0, width, height);
      if (channel === 2) {
        normalPass ??= createNormalPass(gl);
        normalPass.bind(width, height);
      }
      gl.useProgram(program);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform3f(uniforms.forward, cp * sy, sp, cp * cy);
      gl.uniform3f(uniforms.right, cy, 0, -sy);
      gl.uniform3f(uniforms.up, -sp * sy, cp, -sp * cy);
      gl.uniform1f(uniforms.focal, focal);
      gl.uniform1f(uniforms.aspect, aspect);
      gl.uniform1f(uniforms.distanceToCenter, distance);
      gl.uniform1i(uniforms.channel, channel);
      gl.uniform1f(uniforms.azimuth, azimuth * degrees);
      gl.uniform1f(uniforms.support, channel === 5 ? 1 : 3.04);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, model.count);
      if (channel === 2) normalPass.resolve();
    }

    function redraw() {
      if (!frame) frame = requestAnimationFrame(draw);
    }
    function rotate(dx, dy) {
      yaw -= dx;
      pitch = clamp(pitch + dy, -86 * degrees, 86 * degrees);
      redraw();
    }
    function magnify(factor) {
      zoom = clamp(zoom * factor, 0.45, 5);
      redraw();
    }
    function reset() {
      yaw = initialYaw;
      pitch = initialPitch;
      zoom = initialZoom;
      redraw();
    }

    const pointers = new Map();
    const span = () => {
      const [a, b] = pointers.values();
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointers.size >= 2) return;
      canvas.focus({preventScroll: true});
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      canvas.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', event => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const oldSpan = pointers.size === 2 ? span() : 0;
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (pointers.size === 2) {
        const newSpan = span();
        if (oldSpan > 2 && newSpan > 2) magnify(newSpan / oldSpan);
      } else {
        rotate((event.clientX - previous.x) * 0.008, (event.clientY - previous.y) * 0.008);
      }
    });
    const release = event => {
      pointers.delete(event.pointerId);
      if (!pointers.size) canvas.classList.remove('is-dragging');
    };
    for (const event of ['pointercancel', 'pointerup', 'lostpointercapture']) {
      canvas.addEventListener(event, release);
    }
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
      magnify(Math.exp(clamp(-event.deltaY * unit * 0.0015, -1, 1)));
    }, {passive: false});
    const keys = {
      ArrowLeft: () => rotate(0.12, 0), ArrowRight: () => rotate(-0.12, 0),
      ArrowUp: () => rotate(0, 0.12), ArrowDown: () => rotate(0, -0.12),
      '+': () => magnify(1.2), '=': () => magnify(1.2), '-': () => magnify(1 / 1.2), Home: reset
    };
    canvas.addEventListener('keydown', event => {
      if (!Object.hasOwn(keys, event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      keys[event.key]();
    });
    canvas.addEventListener('dblclick', reset);
    canvas.addEventListener('webglcontextlost', onContextLoss);
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    draw();

    return {
      magnify, reset,
      setChannel(value) { channel = value; redraw(); },
      setLight(value) { azimuth = value; redraw(); },
      setEnvironment(map) {
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGB16F, map.width, map.height, map.layers,
                      0, gl.RGB, gl.FLOAT, map.pixels);
        redraw();
      },
      dispose() {
        resize.disconnect();
        cancelAnimationFrame(frame);
        canvas.removeEventListener('webglcontextlost', onContextLoss);
        normalPass?.dispose();
        gl.deleteTexture(texture);
        gl.deleteTexture(lighting);
        gl.deleteBuffer(buffer);
        gl.deleteBuffer(corners);
        gl.deleteProgram(program);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    };
  }

  const viewers = document.querySelectorAll('.model-viewer[data-src]');
  for (const [index, container] of viewers.entries()) {
    const launch = container.querySelector('.model-launch');
    if (!launch) continue;
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', (container.dataset.name || 'Object') + ' model viewer');
    launch.hidden = false;
    const status = document.createElement('p');
    status.className = 'model-status';
    status.setAttribute('role', 'status');
    container.append(status);

    let screen;
    let renderer;
    let request;
    const settings = {surface: container.dataset.initialSurface === 'normal' ? '2' : '6',
                      environment: null, hdrAngle: 0, studioAngle: 45};
    function close(message = '', focus = true) {
      request?.abort();
      request = null;
      renderer?.dispose();
      renderer = null;
      screen?.remove();
      screen = null;
      container.classList.remove('is-active');
      launch.disabled = false;
      launch.hidden = false;
      status.textContent = message;
      if (focus) launch.focus({preventScroll: true});
    }
    container.addEventListener('modelhide', () => close('', false));

    launch.addEventListener('click', async () => {
      const focusOpenedModel = document.activeElement === launch;
      const controller = new AbortController();
      request = controller;
      launch.disabled = true;
      status.textContent = 'Loading model…';
      try {
        const response = await fetch(container.dataset.src, {signal: controller.signal});
        if (!response.ok) throw new Error('The Gaussian model could not be downloaded. Try again.');
        const bytes = await response.arrayBuffer();
        if (request !== controller) return;
        const model = readGaussians(bytes);
        screen = document.createElement('div');
        screen.className = 'model-screen';
        screen.innerHTML = `
          <canvas tabindex="0"></canvas>
          <div class="model-toolbar">
            <label class="model-channel">Surface
              <select><option value="6">HDR environment</option><option value="1">Studio light</option><option value="0">Base color</option><option value="2">Normals (view space)</option><option value="3">Roughness</option><option value="4">Metallic</option><option value="5">Gaussian footprints (1σ)</option></select>
            </label>
            <label class="model-environment" hidden>Environment
              <select></select>
            </label>
            <label class="model-light"><span>Rotation</span>
              <input type="range" min="-180" max="180" step="1" value="45"><output>45°</output>
            </label>
            <div class="model-actions">
              <button type="button" data-action="out" aria-label="Zoom out" title="Zoom out">−</button>
              <button type="button" data-action="in" aria-label="Zoom in" title="Zoom in">+</button>
              <button type="button" data-action="reset">Reset view</button>
              <button type="button" data-action="close">Show preview</button>
            </div>
          </div>
          <p class="model-help"><span class="model-normal-key" hidden>RGB axes point right, up and toward the camera. </span>Drag to orbit and scroll or pinch to zoom. Use the arrow keys to orbit, + / − to zoom, or Home to reset.</p>`;
        container.append(screen);
        container.classList.add('is-active');
        const canvas = screen.querySelector('canvas');
        canvas.setAttribute('aria-label', (container.dataset.name || 'Object') + ' 2D Gaussian splat model');
        const help = screen.querySelector('.model-help');
        help.id = 'model-controls-help-' + index;
        canvas.setAttribute('aria-describedby', help.id);
        renderer = mountRenderer(canvas, model, container.dataset, () => {
          close('The graphics context was interrupted. Open the model to try again.');
        });
        const channelControl = screen.querySelector('.model-channel');
        const lightControl = screen.querySelector('.model-light');
        const surface = channelControl.querySelector('select');
        surface.value = settings.surface;
        const environmentControl = screen.querySelector('.model-environment');
        const environmentSelect = environmentControl.querySelector('select');
        const slider = lightControl.querySelector('input');
        const updateLightLabel = () => {
          const angle = slider.value + '°';
          lightControl.querySelector('output').textContent = angle;
          slider.setAttribute('aria-valuetext', slider.value + ' degrees');
        };
        let catalog, currentMap, revision = 0;
        const activeRenderer = renderer;
        async function updateLighting() {
          const generation = ++revision;
          const current = () => renderer === activeRenderer && generation === revision;
          const channel = Number(surface.value);
          settings.surface = surface.value;
          help.querySelector('.model-normal-key').hidden = channel !== 2;
          container.dispatchEvent(new CustomEvent('modelsurfacechange', {
            bubbles: true, detail: channel === 2 ? 'normal' : surface.value
          }));
          slider.value = channel === 6 ? settings.hdrAngle : settings.studioAngle;
          lightControl.hidden = channel !== 6 && channel !== 1;
          lightControl.querySelector('span').textContent = channel === 6 ? 'Rotation' : 'Light angle';
          environmentControl.hidden = channel !== 6 || !catalog;
          updateLightLabel();
          activeRenderer.setLight(Number(slider.value));
          if (channel !== 6) {
            activeRenderer.setChannel(channel);
            status.textContent = '';
            return;
          }
          try {
            if (!catalog) {
              status.textContent = 'Loading HDR lighting…';
              const nextCatalog = await loadLightingCatalog();
              if (!current()) return;
              catalog = nextCatalog;
              for (const item of catalog.environments) environmentSelect.add(new Option(item.label, item.id));
              if (catalog.environments.some(item => item.id === settings.environment)) {
                environmentSelect.value = settings.environment;
              }
              environmentControl.hidden = false;
            }
            const preset = catalog.environments.find(item => item.id === environmentSelect.value);
            settings.environment = preset.id;
            if (currentMap !== preset.id) {
              status.textContent = 'Loading ' + preset.label + ' lighting…';
              const map = await loadLightingMap(catalog, preset);
              if (!current()) return;
              activeRenderer.setEnvironment(map);
              currentMap = preset.id;
            }
            activeRenderer.setChannel(6);
            status.textContent = '';
          } catch {
            if (!current()) return;
            surface.value = '1';
            updateLighting();
            status.textContent = 'HDR lighting could not be loaded. Studio light is active. Select HDR environment to retry.';
          }
        }
        surface.addEventListener('change', updateLighting);
        environmentSelect.addEventListener('change', updateLighting);
        slider.addEventListener('input', () => {
          updateLightLabel();
          const angle = Number(slider.value);
          if (surface.value === '6') settings.hdrAngle = angle;
          else settings.studioAngle = angle;
          activeRenderer.setLight(angle);
        });
        screen.querySelector('.model-actions').addEventListener('click', event => {
          const action = event.target.closest('button')?.dataset.action;
          if (action === 'reset') renderer.reset();
          if (action === 'in') renderer.magnify(1.25);
          if (action === 'out') renderer.magnify(0.8);
          if (action === 'close') close();
        });
        launch.hidden = true;
        updateLighting();
        if (focusOpenedModel && (document.activeElement === launch || document.activeElement === document.body)) {
          canvas.focus({preventScroll: true});
        }
      } catch (error) {
        if (request !== controller || controller.signal.aborted) return;
        const message = location.protocol === 'file:'
          ? 'Open this page through a local web server to load the model.'
          : error instanceof TypeError ? 'The model could not be loaded. Check the connection and try again.' : error.message;
        close(message, focusOpenedModel && (document.activeElement === launch || document.activeElement === document.body));
      }
    });
  }
})();
