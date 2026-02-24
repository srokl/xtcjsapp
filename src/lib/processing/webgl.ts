export class WebglProcessor {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private positionBuffer: WebGLBuffer
  private texCoordBuffer: WebGLBuffer

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2')
    if (!gl) throw new Error('WebGL2 not supported')
    this.gl = gl

    const vsSource = `#version 300 es
    in vec2 a_position;
    in vec2 a_texCoord;
    out vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord = a_texCoord;
    }`

    const fsSource = `#version 300 es
    precision mediump float;
    
    uniform sampler2D u_image;
    uniform float u_contrast;
    uniform float u_gamma;
    uniform bool u_invert;
    uniform bool u_grayscale;
    
    in vec2 v_texCoord;
    out vec4 outColor;
    
    void main() {
      vec4 color = texture(u_image, v_texCoord);
      
      // Invert
      if (u_invert) {
        color.rgb = 1.0 - color.rgb;
      }
      
      // Grayscale (Luminosity)
      float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      
      // Contrast
      if (u_contrast > 0.0) {
        float c = (1.0 + u_contrast / 10.0); // Map 0-8 range to multiplier
        gray = 0.5 + (gray - 0.5) * c;
        gray = clamp(gray, 0.0, 1.0);
      }
      
      // Gamma
      if (u_gamma != 1.0) {
        gray = pow(gray, u_gamma);
      }
      
      outColor = vec4(vec3(gray), 1.0);
    }`

    this.program = this.createProgram(gl, vsSource, fsSource)
    this.positionBuffer = gl.createBuffer()!
    this.texCoordBuffer = gl.createBuffer()!

    // Setup geometry (quad covering full clip space)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]), gl.STATIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1, // Flip Y for WebGL coords
      1, 1,
      0, 0,
      0, 0,
      1, 1,
      1, 0,
    ]), gl.STATIC_DRAW)
  }

  process(
    source: HTMLCanvasElement | HTMLImageElement | ImageData,
    width: number,
    height: number,
    options: {
      contrast: number
      gamma: number
      invert: boolean
    }
  ): HTMLCanvasElement {
    const gl = this.gl
    this.canvas.width = width
    this.canvas.height = height
    gl.viewport(0, 0, width, height)

    gl.useProgram(this.program)

    // Attributes
    const positionLoc = gl.getAttribLocation(this.program, 'a_position')
    gl.enableVertexAttribArray(positionLoc)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

    const texCoordLoc = gl.getAttribLocation(this.program, 'a_texCoord')
    gl.enableVertexAttribArray(texCoordLoc)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer)
    gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0)

    // Texture
    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    if (source instanceof ImageData) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    }

    // Uniforms
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrast'), options.contrast)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gamma'), options.gamma)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_invert'), options.invert ? 1 : 0)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_grayscale'), 1)

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Read back? Or return canvas.
    // Returning the WebGL canvas is risky if context is lost or repurposed.
    // Better to draw to a 2D canvas or return as is if immediate use.
    // For safety in this async pipeline, let's copy to a new 2D canvas.
    // Actually, creating a new canvas every time is slow.
    // Let's assume we can use the webgl canvas to drawimage.
    
    // Cleanup texture to avoid memory leak
    gl.deleteTexture(texture)

    return this.canvas
  }

  private createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const program = gl.createProgram()!
    const vertexShader = this.createShader(gl, gl.VERTEX_SHADER, vs)
    const fragmentShader = this.createShader(gl, gl.FRAGMENT_SHADER, fs)
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program)!)
    }
    return program
  }

  private createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader)!)
    }
    return shader
  }
}

// Singleton instance
let processor: WebglProcessor | null = null

export function getWebglProcessor(): WebglProcessor {
  if (!processor) {
    processor = new WebglProcessor()
  }
  return processor
}
