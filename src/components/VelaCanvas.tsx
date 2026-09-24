import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const VelaCanvas = () => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    // SCENE SETUP
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0A0F1C');
    
    // CAMERA
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 300;

    // RENDERER
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mountRef.current.appendChild(renderer.domElement);

    // PARAMETERS
    const PARTICLE_COUNT = 120;
    const MAX_DISTANCE = 120;
    const MOUSE_RADIUS = 80;
    const MOUSE_FORCE = 0.3;

    // PARTICLES (Points)
    const particlesGeometry = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    const particleVelocities: THREE.Vector3[] = [];
    const basePositions: THREE.Vector3[] = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const x = (Math.random() - 0.5) * 800;
        const y = (Math.random() - 0.5) * 800;
        const z = (Math.random() - 0.5) * 500;
        
        particlePositions[i * 3] = x;
        particlePositions[i * 3 + 1] = y;
        particlePositions[i * 3 + 2] = z;
        
        basePositions.push(new THREE.Vector3(x, y, z));
        particleVelocities.push(
            new THREE.Vector3(
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4
            )
        );
    }

    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    
    // Material 1: The Dots
    const pointsMaterial = new THREE.PointsMaterial({
        color: '#1E40AF',
        size: 1.5,
        sizeAttenuation: true,
        transparent: false,
    });
    const particlesMesh = new THREE.Points(particlesGeometry, pointsMaterial);
    
    // Material 2: The Lines
    const linesGeometry = new THREE.BufferGeometry();
    const linesMaterial = new THREE.LineBasicMaterial({
        color: 0x3b82f6,
        transparent: true,
        opacity: 0.15,
        depthWrite: false
    });
    
    const linesMesh = new THREE.LineSegments(linesGeometry, linesMaterial);
    
    // Group to rotate everything together
    const group = new THREE.Group();
    group.add(particlesMesh);
    group.add(linesMesh);
    scene.add(group);

    // MOUSE INTERACTION
    const mouse = new THREE.Vector2(-9999, -9999);
    
    const onMouseMove = (event: MouseEvent) => {
        // Convert screen coordinates to normalized device coordinates (-1 to +1)
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    };
    
    window.addEventListener('mousemove', onMouseMove);

    // RESIZE
    const handleResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // ANIMATION LOOP
    let animationFrameId: number;
    const raycaster = new THREE.Raycaster();
    const mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const mouseWorldPos = new THREE.Vector3();

    const animate = () => {
        animationFrameId = requestAnimationFrame(animate);

        // Group rotation
        group.rotation.x += 0.0005;
        group.rotation.y += 0.0003;

        // Mouse repelling calculation
        raycaster.setFromCamera(mouse, camera);
        raycaster.ray.intersectPlane(mousePlane, mouseWorldPos);
        
        // Since group is rotating, mouse world pos needs to be mapped to group's local space
        const localMousePos = mouseWorldPos.clone().applyMatrix4(group.matrixWorld.clone().invert());

        const positions = particlesGeometry.attributes.position.array as Float32Array;
        const linePositions = [];

        // Update particle positions
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const idx = i * 3;
            
            // Move by velocity
            positions[idx] += particleVelocities[i].x;
            positions[idx + 1] += particleVelocities[i].y;
            positions[idx + 2] += particleVelocities[i].z;
            
            // Boundary bounce
            if (Math.abs(positions[idx]) > 400) particleVelocities[i].x *= -1;
            if (Math.abs(positions[idx+1]) > 400) particleVelocities[i].y *= -1;
            if (Math.abs(positions[idx+2]) > 250) particleVelocities[i].z *= -1;

            const currentPos = new THREE.Vector3(positions[idx], positions[idx+1], positions[idx+2]);
            
            // Mouse Repel
            if (mouse.x !== -9999) {
                const distToMouse = currentPos.distanceTo(localMousePos);
                if (distToMouse < MOUSE_RADIUS) {
                    const repelDir = currentPos.clone().sub(localMousePos).normalize();
                    // Push particle
                    positions[idx] += repelDir.x * MOUSE_FORCE * (MOUSE_RADIUS - distToMouse) * 0.1;
                    positions[idx+1] += repelDir.y * MOUSE_FORCE * (MOUSE_RADIUS - distToMouse) * 0.1;
                    positions[idx+2] += repelDir.z * MOUSE_FORCE * (MOUSE_RADIUS - distToMouse) * 0.1;
                }
            }
            
            // Check connections with other particles
            // O(N^2) but with N=120 it's 14,400 checks, extremely fast for modern JS
            for (let j = i + 1; j < PARTICLE_COUNT; j++) {
                const jdx = j * 3;
                const dx = positions[idx] - positions[jdx];
                const dy = positions[idx+1] - positions[jdx+1];
                const dz = positions[idx+2] - positions[jdx+2];
                const distSq = dx*dx + dy*dy + dz*dz;
                
                if (distSq < MAX_DISTANCE * MAX_DISTANCE) {
                    linePositions.push(
                        positions[idx], positions[idx+1], positions[idx+2],
                        positions[jdx], positions[jdx+1], positions[jdx+2]
                    );
                }
            }
        }

        particlesGeometry.attributes.position.needsUpdate = true;
        
        // Update lines
        linesGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

        renderer.render(scene, camera);
    };

    animate();

    // CLEANUP
    return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('mousemove', onMouseMove);
        cancelAnimationFrame(animationFrameId);
        if (mountRef.current && renderer.domElement) {
            mountRef.current.removeChild(renderer.domElement);
        }
        particlesGeometry.dispose();
        pointsMaterial.dispose();
        linesGeometry.dispose();
        linesMaterial.dispose();
        renderer.dispose();
    };
  }, []);

  return (
    <div 
      ref={mountRef} 
      style={{ 
        position: 'absolute', 
        top: 0, 
        left: 0, 
        width: '100%', 
        height: '100%', 
        overflow: 'hidden',
        pointerEvents: 'none', // Lets clicks pass through to whatever is behind/above it if needed, though this is full left column
        zIndex: 0
      }} 
    />
  );
};

export default VelaCanvas;
