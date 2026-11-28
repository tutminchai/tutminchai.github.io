const TAU = Math.PI * 2
const FOV = Math.PI / 5.5

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(v) {
  const d = Math.hypot(...v) || 1
  return v.map(x => x / d)
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function frameModel(model) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < model.positions.length; i++) {
    const axis = i % 3, p = model.positions[i]
    if (p < lo[axis]) lo[axis] = p
    if (p > hi[axis]) hi[axis] = p
  }
  const size = hi.map((v, i) => v - lo[i])
  const center = lo.map((v, i) => v + size[i] / 2)
  const radius = Math.max(Math.hypot(...size) / 2, 0.001)
  return { center, size, radius, floor: lo[1] }
}

function camera(bounds, yaw, pitch, zoom, aspect) {
  const { center, size, radius } = bounds
  const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)], up = cross(back, right)
  const focal = 1 / Math.tan(FOV / 2)
  // Keep the zoom stable while orbiting. Account for the horizontal field on narrower screens.
  const fit = Math.max(size[1] * 0.5, Math.hypot(size[0], size[2]) * 0.5 / aspect, radius * 0.32)
  const distance = (fit * focal * 1.15 + radius * 0.45) * zoom
  const eye = center.map((v, i) => v + back[i] * distance)
  const near = Math.max(radius * 0.003, distance - radius * 2.5)
  const far = distance + radius * 20
  const a = (far + near) / (near - far), b = (2 * far * near) / (near - far)
  const sx = focal / aspect, sy = focal
  const matrix = new Float32Array([
    right[0]*sx, up[0]*sy, back[0]*a, -back[0],
    right[1]*sx, up[1]*sy, back[1]*a, -back[1],
    right[2]*sx, up[2]*sy, back[2]*a, -back[2],
    -dot(right,eye)*sx, -dot(up,eye)*sy, -dot(back,eye)*a+b, dot(back,eye)
  ])
  return { matrix, eye, back, right, up, distance, focal, near }
}

const meshVertex = `
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec2 uv;
  uniform mat4 vp;
  varying vec3 vNormal;
  varying vec2 vUV;
  void main() {
    vNormal = normal;
    vUV = uv;
    gl_Position = vp * vec4(position,1.);
  }`

const meshFragment = `
  precision mediump float;
  varying vec3 vNormal;
  varying vec2 vUV;
  uniform sampler2D surface;
  uniform float wire;
  void main() {
    vec4 texel = texture2D(surface, vUV);
    if (texel.a < .07) discard;
    vec3 n = normalize(vNormal);
    float diffuse = max(dot(n, normalize(vec3(-.45,.8,1.))), 0.);
    float light = .79 + .26 * diffuse + .045 * max(-n.y, 0.);
    vec3 color = texel.rgb * light;
    color = mix(color, vec3(.23,.22,.19), wire * .83);
    gl_FragColor = vec4(color, 1.);
  }`

const floorVertex = `
  attribute vec2 unitPosition;
  uniform mat4 vp;
  uniform vec3 center;
  uniform float radius;
  varying vec2 local;
  void main() {
    local = unitPosition * 6.;
    vec3 p = center + vec3(local.x,0.,local.y) * radius;
    gl_Position = vp * vec4(p,1.);
  }`

function makeProgram(gl, vertex, fragment) {
  const shaders = []
  const program = gl.createProgram()
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader = gl.createShader(type)
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
    return program
  } catch (err) {
    gl.deleteProgram(program)
    throw err
  } finally {
    for (const shader of shaders) gl.deleteShader(shader)
  }
}

function glRenderer(gl) {
  const derivative = gl.getExtension('OES_standard_derivatives')
  const floorFragment = (derivative ? '#extension GL_OES_standard_derivatives : enable\n' : '') + `
    precision mediump float;
    varying vec2 local;
    uniform vec2 footprint;
    void main() {
      vec2 cell = local * 3.;
      vec2 edge = abs(fract(cell + .5) - .5);
      ${derivative ? 'vec2 aa = max(fwidth(cell), vec2(.001));' : 'vec2 aa = vec2(.028);'}
      float line = 1. - smoothstep(.1, 1.1, min(edge.x / aa.x, edge.y / aa.y));
      float fade = 1. - smoothstep(1.1,4.4,length(local));
      vec2 shadowPos = local / footprint;
      float shadow = .19 * exp(-dot(shadowPos,shadowPos)*2.);
      float alpha = shadow + line * fade * .13;
      gl_FragColor = vec4(.32,.31,.28,alpha);
    }`
  const solid = makeProgram(gl, meshVertex, meshFragment), floor = makeProgram(gl, floorVertex, floorFragment)
  const locations = (program, names, attributes) => Object.fromEntries([
    ...names.map(n => [n, gl.getUniformLocation(program,n)]),
    ...attributes.map(n => [n, gl.getAttribLocation(program,n)])
  ])
  const meshAt = locations(solid,['vp','wire','surface'],['position','normal','uv'])
  const floorAt = locations(floor,['vp','radius','center','footprint'],['unitPosition'])
  function buffer(target, data) {
    const buf = gl.createBuffer()
    gl.bindBuffer(target,buf)
    gl.bufferData(target,data,gl.STATIC_DRAW)
    return buf
  }
  function attribute(at, buf, size) {
    gl.bindBuffer(gl.ARRAY_BUFFER,buf)
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0)
  }
  const floorBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1 ,-1,1, 1,1]))
  const wideIndices = !!gl.getExtension('OES_element_index_uint')
  let mesh = null
  function clearMesh() {
    if (!mesh) return
    for (const buf of mesh.buffers) gl.deleteBuffer(buf)
    gl.deleteTexture(mesh.texture)
    mesh = null
  }
  function load(model, image) {
    clearMesh()
    if (!model) return
    const {positions,normals,uvs,indices} = model
    const useWide = positions.length / 3 > 65535
    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D,texture)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([217,211,195,255]))
    if (image) {
      const w = image.naturalWidth || image.videoWidth || image.width
      const h = image.naturalHeight || image.videoHeight || image.height
      const scale = Math.min(1, gl.getParameter(gl.MAX_TEXTURE_SIZE) / Math.max(w,h))
      // A canvas source also normalizes ImageBitmap orientation for UNPACK_FLIP_Y_WEBGL.
      const source = document.createElement('canvas')
      source.width = Math.max(1,Math.round(w*scale))
      source.height = Math.max(1,Math.round(h*scale))
      source.getContext('2d').drawImage(image,0,0,source.width,source.height)
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source)
    }
    const chunks = [], buffers = []
    function addChunk(pos, norm, uv, triangleIndices) {
      const triangles = buffer(gl.ELEMENT_ARRAY_BUFFER,triangleIndices)
      const chunk = {
        pos:buffer(gl.ARRAY_BUFFER,pos), norm:buffer(gl.ARRAY_BUFFER,norm),
        uv:buffer(gl.ARRAY_BUFFER,uv), triangles, count:triangleIndices.length,
        indices:triangleIndices, type:triangleIndices.BYTES_PER_ELEMENT === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
        lines:null
      }
      chunks.push(chunk)
      buffers.push(chunk.pos,chunk.norm,chunk.uv,triangles)
    }
    if (useWide && !wideIndices) {
      // WebGL 1 devices without 32-bit index support can still render full geometry.
      const limit = 65535
      for (let first = 0; first < indices.length; first += limit) {
        const count = Math.min(limit,indices.length-first)
        const p = new Float32Array(count*3), n = new Float32Array(count*3), u = new Float32Array(count*2)
        const sequential = new Uint16Array(count)
        for (let k=0; k<count; k++) {
          const src = indices[first+k]
          p.set(positions.subarray(src*3,src*3+3),k*3)
          n.set(normals.subarray(src*3,src*3+3),k*3)
          u.set(uvs.subarray(src*2,src*2+2),k*2)
          sequential[k] = k
        }
        addChunk(p,n,u,sequential)
      }
    } else {
      addChunk(positions,normals,uvs,useWide ? new Uint32Array(indices) : new Uint16Array(indices))
    }
    mesh = { chunks, buffers, texture }
  }
  function draw(cam, bounds, wire, width, height) {
    gl.viewport(0,0,width,height)
    gl.clearColor(0,0,0,0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!mesh) return
    gl.disable(gl.CULL_FACE)
    if (cam.eye[1] > bounds.floor) {
      gl.useProgram(floor)
      attribute(floorAt.unitPosition,floorBuffer,2)
      gl.uniformMatrix4fv(floorAt.vp,false,cam.matrix)
      gl.uniform1f(floorAt.radius,bounds.radius)
      gl.uniform3f(floorAt.center,bounds.center[0],bounds.floor - bounds.radius*.008,bounds.center[2])
      gl.uniform2f(floorAt.footprint,Math.max(.25,bounds.size[0]/bounds.radius*.48),Math.max(.18,bounds.size[2]/bounds.radius*.53))
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.DEPTH_TEST)
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
      gl.disableVertexAttribArray(floorAt.unitPosition)
      gl.disable(gl.BLEND)
    }
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.useProgram(solid)
    gl.uniformMatrix4fv(meshAt.vp,false,cam.matrix)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D,mesh.texture)
    gl.uniform1i(meshAt.surface,0)
    for (const chunk of mesh.chunks) {
      attribute(meshAt.position,chunk.pos,3)
      attribute(meshAt.normal,chunk.norm,3)
      attribute(meshAt.uv,chunk.uv,2)
      gl.uniform1f(meshAt.wire,0)
      if (wire) {
        gl.enable(gl.POLYGON_OFFSET_FILL)
        gl.polygonOffset(1,1)
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,chunk.triangles)
      gl.drawElements(gl.TRIANGLES,chunk.count,chunk.type,0)
      if (wire) {
        gl.disable(gl.POLYGON_OFFSET_FILL)
        if (!chunk.lines) {
          const indices = chunk.indices
          const edges = new indices.constructor(indices.length*2)
          for (let i=0; i<indices.length; i+=3) {
            const a=indices[i], b=indices[i+1], c=indices[i+2]
            const j=i*2
            edges[j]=a; edges[j+1]=b; edges[j+2]=b; edges[j+3]=c; edges[j+4]=c; edges[j+5]=a
          }
          chunk.lines = buffer(gl.ELEMENT_ARRAY_BUFFER,edges)
          mesh.buffers.push(chunk.lines)
        }
        gl.uniform1f(meshAt.wire,1)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,chunk.lines)
        gl.drawElements(gl.LINES,chunk.count*2,chunk.type,0)
      }
      gl.disableVertexAttribArray(meshAt.position)
      gl.disableVertexAttribArray(meshAt.normal)
      gl.disableVertexAttribArray(meshAt.uv)
    }
  }
  return { load, draw, destroy() {
    clearMesh()
    gl.deleteBuffer(floorBuffer)
    gl.deleteProgram(solid)
    gl.deleteProgram(floor)
  }}
}

function softwareRenderer(canvas) {
  const ctx = canvas.getContext('2d')
  let model = null, colors = []
  function load(next, image) {
    model = next
    colors = []
    if (!model) return
    let pixels
    if (image) {
      const tex = document.createElement('canvas')
      tex.width = tex.height = 128
      const t = tex.getContext('2d',{willReadFrequently:true})
      t.drawImage(image,0,0,128,128)
      pixels = t.getImageData(0,0,128,128).data
    }
    const {indices,uvs,normals} = model
    for (let i=0; i<indices.length; i+=3) {
      let u=0,v=0,nx=0,ny=0,nz=0
      for (let k=0; k<3; k++) {
        const vert=indices[i+k]
        u+=uvs[vert*2]; v+=uvs[vert*2+1]
        nx+=normals[vert*3]; ny+=normals[vert*3+1]; nz+=normals[vert*3+2]
      }
      const x=Math.max(0,Math.min(127,Math.round(u*127/3))), y=Math.max(0,Math.min(127,Math.round((1-v/3)*127)))
      const offset = (y*128+x)*4
      const light = .79+.26*Math.max(0, dot(unit([nx,ny,nz]),[-.332,.59,.736]))
      const base = pixels ? pixels.subarray(offset, offset+3) : [217,211,195]
      colors.push(pixels && pixels[offset+3]<18 ? null : 'rgb('+Array.from(base,c=>Math.min(255,Math.round(c*light))).join(',')+')')
    }
  }
  function draw(cam, bounds, wire, width, height) {
    if (!ctx) return
    ctx.clearRect(0,0,width,height)
    if (!model) return
    const {positions,indices} = model, projected=new Float32Array(positions.length)
    const mat=cam.matrix
    for (let i=0; i<positions.length; i+=3) {
      const x=positions[i], y=positions[i+1], z=positions[i+2]
      const depth=mat[3]*x+mat[7]*y+mat[11]*z+mat[15]
      projected[i]=width*.5*(1+(mat[0]*x+mat[4]*y+mat[8]*z+mat[12])/depth)
      projected[i+1]=height*.5*(1-(mat[1]*x+mat[5]*y+mat[9]*z+mat[13])/depth)
      projected[i+2]=depth
    }
    const faces=[]
    for (let i=0; i<indices.length; i+=3) {
      const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3
      if (colors[i/3] && Math.min(projected[a+2],projected[b+2],projected[c+2])>cam.near) {
        faces.push([i,projected[a+2]+projected[b+2]+projected[c+2]])
      }
    }
    faces.sort((a,b)=>b[1]-a[1])
    ctx.lineJoin='round'
    ctx.lineWidth=wire ? .8 : .45
    for (const [i] of faces) {
      const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3
      ctx.fillStyle=colors[i/3]; ctx.strokeStyle=wire ? '#55544f' : colors[i/3]
      ctx.beginPath()
      ctx.moveTo(projected[a],projected[a+1])
      ctx.lineTo(projected[b],projected[b+1])
      ctx.lineTo(projected[c],projected[c+1])
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
  }
  return { load, draw, destroy(){model=null; colors=[]} }
}

export function createViewer(canvas) {
  let gl = null
  try { gl = canvas.getContext('webgl',{alpha:true,antialias:true,powerPreference:'low-power'}) } catch {}
  let renderer = gl ? glRenderer(gl) : softwareRenderer(canvas)
  let model = null, image = null, bounds = null, wire = false, rotating = false
  let yaw=.38, pitch=.16, zoom=1, frame=0, previous=0, lost=false, disposed=false
  const pointers = new Map()
  const cleanup = []
  const clamp = (v,lo,hi) => Math.min(hi,Math.max(lo,v))
  function render(now) {
    frame=0
    if (lost || disposed) return
    const rect=canvas.getBoundingClientRect(), scale=Math.min(window.devicePixelRatio||1,2)
    const width=Math.max(1,Math.round(rect.width*scale)), height=Math.max(1,Math.round(rect.height*scale))
    if (canvas.width!==width) canvas.width=width
    if (canvas.height!==height) canvas.height=height
    if (rotating && model && !pointers.size && previous) yaw=(yaw+Math.min(80,now-previous)*.00027)%TAU
    previous=now
    const cam=bounds ? camera(bounds,yaw,pitch,zoom,width/height) : null
    renderer.draw(cam,bounds,wire,width,height)
    if (rotating && model && !document.hidden) requestDraw()
  }
  function requestDraw() {
    if (!frame && !lost && !disposed) frame=requestAnimationFrame(render)
  }
  function reset() {
    yaw=.38; pitch=.16; zoom=1; previous=0
    requestDraw()
  }
  function changeZoom(factor) {
    zoom=clamp(zoom*factor,.36,4.8)
    requestDraw()
  }
  function orbit(dx,dy) {
    yaw=(yaw-dx)%TAU
    pitch=clamp(pitch+dy,-1.45,1.45)
    requestDraw()
  }
  function on(target,type,fn,opts) {
    target.addEventListener(type,fn,opts)
    cleanup.push(()=>target.removeEventListener(type,fn,opts))
  }
  const previousTouchAction = canvas.style.touchAction
  canvas.style.touchAction='none'
  const originalTabIndex=canvas.getAttribute('tabindex')
  if (originalTabIndex===null) canvas.tabIndex=0
  const pointerDistance=() => {
    const [a,b]=pointers.values()
    return Math.hypot(a.x-b.x,a.y-b.y)
  }
  on(canvas,'pointerdown',event=>{
    if (!model || (event.pointerType==='mouse' && event.button!==0)) return
    canvas.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY})
  })
  on(canvas,'pointermove',event=>{
    const old=pointers.get(event.pointerId)
    if (!old) return
    const pinch=pointers.size===2, before=pinch ? pointerDistance() : 0
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY})
    if (pinch) {
      const after=pointerDistance()
      if (before>1 && after>1) changeZoom(before/after)
    } else if (pointers.size===1) {
      const speed=Math.PI/Math.max(180,Math.min(canvas.clientWidth,canvas.clientHeight))
      orbit((event.clientX-old.x)*speed,(event.clientY-old.y)*speed)
    }
  })
  const endPointer=e=>{pointers.delete(e.pointerId)}
  for (const type of ['lostpointercapture','pointerup','pointercancel']) on(canvas,type,endPointer)
  on(canvas,'wheel',event=>{
    if (!model) return
    event.preventDefault()
    const scale=event.deltaMode===1 ? 16 : event.deltaMode===2 ? canvas.clientHeight : 1
    changeZoom(Math.exp(clamp(event.deltaY*scale,-150,150)*.0016))
  },{passive:false})
  on(canvas,'dblclick',reset)
  on(canvas,'keydown',event=>{
    if (!model || event.ctrlKey || event.metaKey || event.altKey) return
    const keys={
      ArrowLeft:()=>orbit(-.12,0), ArrowRight:()=>orbit(.12,0),
      ArrowUp:()=>orbit(0,.1), ArrowDown:()=>orbit(0,-.1),
      '+':()=>changeZoom(.88),'=':()=>changeZoom(.88),'-':()=>changeZoom(1.12),Home:reset
    }
    if (Object.hasOwn(keys,event.key)) {event.preventDefault(); keys[event.key]()}
  })
  on(canvas,'webglcontextlost',e=>{e.preventDefault(); lost=true})
  on(canvas,'webglcontextrestored',()=>{
    if (!gl) return
    lost=false
    renderer=glRenderer(gl)
    renderer.load(model,image)
    requestDraw()
  })
  on(document,'visibilitychange',()=>{previous=0; requestDraw()})
  const observer=typeof ResizeObserver==='function' ? new ResizeObserver(requestDraw) : null
  if (observer) observer.observe(canvas)
  on(window,'resize',requestDraw)
  requestDraw()
  return {
    setModel(next,textureImage) {
      model=next && next.positions.length && next.indices.length ? next : null
      image=model ? textureImage : null
      bounds=model ? frameModel(model) : null
      if (!lost) renderer.load(model,image)
      reset()
    },
    reset,
    setWireframe(value) {wire=Boolean(value); requestDraw()},
    setRotation(value) {rotating=Boolean(value); previous=0; requestDraw()},
    destroy() {
      disposed=true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      for (const remove of cleanup) remove()
      if (!lost) renderer.destroy()
      pointers.clear()
      model=null; image=null
      canvas.style.touchAction=previousTouchAction
      if (originalTabIndex===null) canvas.removeAttribute('tabindex')
    }
  }
}
