import * as THREE from "three";

// NaN/Inf guard for every built-in material.
//
// Some GPUs produce NaN for a handful of pixels in edge cases (for example
// normalize() of a zero-length derivative). On its own that is one invisible
// pixel, but the HDR bloom blur smears it across its mip chain into a large,
// flickering black square. Sanitizing every material's output removes the
// whole class of bug. clamp() also catches NaN on most drivers (IEEE min/max
// return the non-NaN operand); isnan/isinf cover the rest.
const GUARD = /* glsl */ `
if ( any( isnan( gl_FragColor ) ) || any( isinf( gl_FragColor ) ) ) gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
gl_FragColor = clamp( gl_FragColor, 0.0, 64.0 );
`;

if (!THREE.ShaderChunk.opaque_fragment.includes("isnan")) {
  THREE.ShaderChunk.opaque_fragment += GUARD;
}
