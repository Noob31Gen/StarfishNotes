import React, { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Settings, SlidersHorizontal, Search, RefreshCw } from 'lucide-react';
import { cn } from '../utils/cn';
import { safeParseJson } from '../utils/json';

interface Node {
  id: string; // The full file path
  name: string; // Just the file name
  type: 'md' | 'canvas' | 'base' | 'ghost';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
}

interface Link {
  source: string;
  target: string;
}

interface GraphViewProps {
  files: { path: string; name: string; sha: string }[];
  fileContents: Record<string, string>; // path -> content mapping for link scanning
  onOpenNote: (path: string) => void;
  activeFilePath?: string;
  nodeGravity?: number;
  repulsionStrength?: number;
  springLength?: number;
  onPrefetchAll?: () => void;
  prefetchStatus?: 'idle' | 'fetching' | 'success' | 'error';
  prefetchProgress?: { loaded: number; total: number };
}

const GraphViewComponent: React.FC<GraphViewProps> = ({
  files,
  fileContents,
  onOpenNote,
  activeFilePath,
  nodeGravity: propsNodeGravity,
  repulsionStrength: propsRepulsionStrength,
  springLength: propsSpringLength,
  onPrefetchAll,
  prefetchStatus = 'idle',
  prefetchProgress = { loaded: 0, total: 0 },
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(0.5);

  // Animation/Physics references
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const isDraggingRef = useRef<boolean>(false);
  const dragNodeRef = useRef<Node | null>(null);
  const dragStartScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hoverNodeRef = useRef<Node | null>(null);
  const touchActiveNodeRef = useRef<Node | null>(null);
  const initialPinchDistance = useRef<number | null>(null);
  const initialPinchZoom = useRef<number>(0.5);
  const isTouchRef = useRef<boolean>(false);

  // Collapsible settings & physics filters states
  const [showCanvas, setShowCanvas] = useState(true);
  const [showGhosts, setShowGhosts] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [searchHighlight, setSearchHighlight] = useState('');
  const [isControlsOpen, setIsControlsOpen] = useState(false);

  // Physics customization values
  const [repulsionStrength, setRepulsionStrength] = useState(propsRepulsionStrength ?? 180);
  const [springLength, setSpringLength] = useState(propsSpringLength ?? 120);
  const [gravity, setGravity] = useState(propsNodeGravity ?? 0.02);

  // Prop updates synchronization in render phase to avoid cascading renders warning
  const [prevPhysicsProps, setPrevPhysicsProps] = useState({
    propsRepulsionStrength,
    propsSpringLength,
    propsNodeGravity
  });

  if (
    propsRepulsionStrength !== prevPhysicsProps.propsRepulsionStrength ||
    propsSpringLength !== prevPhysicsProps.propsSpringLength ||
    propsNodeGravity !== prevPhysicsProps.propsNodeGravity
  ) {
    setPrevPhysicsProps({
      propsRepulsionStrength,
      propsSpringLength,
      propsNodeGravity
    });
    if (propsRepulsionStrength !== undefined) setRepulsionStrength(propsRepulsionStrength);
    if (propsSpringLength !== undefined) setSpringLength(propsSpringLength);
    if (propsNodeGravity !== undefined) setGravity(propsNodeGravity);
  }

  const repulsionRef = useRef(repulsionStrength);
  const springLengthRef = useRef(springLength);
  const gravityRef = useRef(gravity);
  const searchHighlightRef = useRef(searchHighlight);

  const zoomRef = useRef(zoom);
  const panXRef = useRef(0);
  const panYRef = useRef(0);

  useEffect(() => {
    repulsionRef.current = repulsionStrength;
  }, [repulsionStrength]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    springLengthRef.current = springLength;
  }, [springLength]);

  useEffect(() => {
    gravityRef.current = gravity;
  }, [gravity]);

  useEffect(() => {
    searchHighlightRef.current = searchHighlight;
  }, [searchHighlight]);

  useEffect(() => {
    // Filter out internal system files (.gitkeep and .vault-compat.json)
    const graphFiles = files.filter(f => f.name !== '.gitkeep' && f.name !== '.vault-compat.json');

    // 1. Scan for Links & compile Ghost Notes
    const currentLinks: Link[] = [];
    const ghostNotesMap = new Map<string, { id: string; name: string }>();

    graphFiles.forEach(file => {
      if (file.path.endsWith('.md')) {
        const content = fileContents[file.path] || '';

        // Scan for Wikilinks: [[Target Note]] or [[Folder/Target Note]]
        const graphviewLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let match;
        while ((match = graphviewLinkRegex.exec(content)) !== null) {
          const rawTargetName = match[1].trim();

          // Normalize paths by replacing backslashes with forward slashes, stripping leading dots/slashes, and trimming
          let cleanTarget = rawTargetName.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
          // Remove common markdown/board/text extensions for match comparisons
          cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

          const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

          // Match against name OR full path
          const targetFile = graphFiles.find(f => {
            const cleanName = f.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();
            const cleanPath = f.path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();

            // Standard Obsidian matching rules:
            // 1. Matches exact filename (e.g. "1 - IMPORTED FROM KEEP")
            // 2. Matches exact full path (e.g. "+base-planes/1 - imported from keep")
            // 3. Matches relative/nested subfolder matches (e.g. ends with "/1 - imported from keep")
            // 4. Matches filename only fallback if folder was specified
            return cleanName === cleanTarget || cleanPath === cleanTarget || cleanPath.endsWith('/' + cleanTarget) || cleanName === targetFilename;
          });

          if (targetFile) {
            if (targetFile.path !== file.path) {
              const linkExists = currentLinks.some(
                l => (l.source === file.path && l.target === targetFile.path) ||
                  (l.source === targetFile.path && l.target === file.path)
              );
              if (!linkExists) {
                currentLinks.push({ source: file.path, target: targetFile.path });
              }
            }
          } else {
            // Ghost Note
            const ghostPath = rawTargetName.endsWith('.md') ? rawTargetName : `${rawTargetName}.md`;
            const ghostPathLower = ghostPath.toLowerCase();

            let existingGhost = ghostNotesMap.get(ghostPathLower);
            if (!existingGhost) {
              existingGhost = {
                id: ghostPath,
                name: rawTargetName,
              };
              ghostNotesMap.set(ghostPathLower, existingGhost);
            }

            const linkExists = currentLinks.some(
              l => (l.source === file.path && l.target === existingGhost!.id) ||
                (l.source === existingGhost!.id && l.target === file.path)
            );
            if (!linkExists) {
              currentLinks.push({ source: file.path, target: existingGhost.id });
            }
          }
        }

        // Scan for Standard Markdown links: [Text](Folder/Note.md)
        const mdLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
        let mdMatch;
        while ((mdMatch = mdLinkRegex.exec(content)) !== null) {
          let targetPath = mdMatch[1].trim();

          if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) continue;

          try { targetPath = decodeURIComponent(targetPath); } catch { /* ignore decode errors */ }

          let cleanTarget = targetPath.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
          cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

          const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

          const targetFile = graphFiles.find(f => {
            const cleanName = f.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();
            const cleanPath = f.path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();

            return cleanName === cleanTarget || cleanPath === cleanTarget || cleanPath.endsWith('/' + cleanTarget) || cleanName === targetFilename;
          });

          if (targetFile) {
            if (targetFile.path !== file.path) {
              const linkExists = currentLinks.some(
                l => (l.source === file.path && l.target === targetFile.path) ||
                  (l.source === targetFile.path && l.target === file.path)
              );
              if (!linkExists) {
                currentLinks.push({ source: file.path, target: targetFile.path });
              }
            }
          } else {
            if (targetPath.endsWith('.md') || targetPath.endsWith('.txt')) {
              const cleanGhostName = targetPath.split('/').pop()?.replace(/\.md$/, '').replace(/\.txt$/, '') || targetPath;
              const ghostPath = targetPath;
              const ghostPathLower = ghostPath.toLowerCase();

              let existingGhost = ghostNotesMap.get(ghostPathLower);
              if (!existingGhost) {
                existingGhost = {
                  id: ghostPath,
                  name: cleanGhostName,
                };
                ghostNotesMap.set(ghostPathLower, existingGhost);
              }

              const linkExists = currentLinks.some(
                l => (l.source === file.path && l.target === existingGhost!.id) ||
                  (l.source === existingGhost!.id && l.target === file.path)
              );
              if (!linkExists) {
                currentLinks.push({ source: file.path, target: existingGhost.id });
              }
            }
          }
        }
      } else if (file.path.endsWith('.canvas')) {
        try {
          const content = fileContents[file.path] || '{}';
          const canvasData = safeParseJson<{ nodes?: { type?: string; file?: string }[] }>(content, {});
          if (canvasData.nodes && Array.isArray(canvasData.nodes)) {
            canvasData.nodes.forEach((node) => {
              if (node.type === 'file' && node.file) {
                let cleanTarget = node.file.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
                cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

                const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

                const targetFile = graphFiles.find(f => {
                  const cleanName = f.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();
                  const cleanPath = f.path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();
                  return cleanName === cleanTarget || cleanPath === cleanTarget || cleanPath.endsWith('/' + cleanTarget) || cleanName === targetFilename;
                });

                if (targetFile) {
                  currentLinks.push({
                    source: file.path,
                    target: targetFile.path,
                  });
                }
              }
            });
          }
        } catch { /* ignore canvas parse errors */ }
      }
    });

    const cx = containerRef.current ? containerRef.current.clientWidth / 2 : window.innerWidth / 2;
    const cy = containerRef.current ? containerRef.current.clientHeight / 2 : window.innerHeight / 2;

    // 2. Build Base Nodes
    const baseNodes: Node[] = graphFiles.map((file, idx) => {
      const isCanvas = file.path.endsWith('.canvas');
      const isBase = file.path.endsWith('.base');
      const isCurrentActive = file.path === activeFilePath;
      const existing = nodesRef.current.find(n => n.id === file.path);
      const angle = graphFiles.length > 0 ? (idx / graphFiles.length) * 2 * Math.PI : 0;
      const radius = 220;

      return {
        id: file.path,
        name: file.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.base$/, ''),
        type: isCanvas ? 'canvas' : isBase ? 'base' : 'md',
        x: existing ? existing.x : cx + Math.cos(angle) * radius,
        y: existing ? existing.y : cy + Math.sin(angle) * radius,
        vx: existing ? existing.vx : 0,
        vy: existing ? existing.vy : 0,
        radius: isCurrentActive ? 9 : 6,
        color: isCurrentActive
          ? isCanvas
            ? '#2dd4bf'
            : isBase
              ? '#f87171'
              : '#c084fc'
          : isCanvas
            ? '#0d9488' // Premium teal
            : isBase
              ? '#ef4444' // Premium Red
              : '#8b5cf6', // Premium Purple
      };
    });

    // 3. Build Ghost Nodes
    const ghostNodes: Node[] = [];
    if (showGhosts) {
      Array.from(ghostNotesMap.values()).forEach((ghost) => {
        const existing = nodesRef.current.find(n => n.id === ghost.id);
        const angle = Math.random() * 2 * Math.PI;
        const radius = 240;

        ghostNodes.push({
          id: ghost.id,
          name: ghost.name,
          type: 'ghost',
          x: existing ? existing.x : cx + Math.cos(angle) * radius,
          y: existing ? existing.y : cy + Math.sin(angle) * radius,
          vx: existing ? existing.vx : 0,
          vy: existing ? existing.vy : 0,
          radius: 5.5,
          color: '#475569',
        });
      });
    }

    let allNodes = [...baseNodes, ...ghostNodes];
    let allLinks = currentLinks;

    // Apply Toggles Filters
    if (!showCanvas) {
      allNodes = allNodes.filter(n => n.type !== 'canvas');
      allLinks = allLinks.filter(l => {
        const sourceNode = allNodes.find(n => n.id === l.source);
        const targetNode = allNodes.find(n => n.id === l.target);
        return sourceNode && targetNode;
      });
    }

    if (!showGhosts) {
      allNodes = allNodes.filter(n => n.type !== 'ghost');
      allLinks = allLinks.filter(l => {
        const sourceNode = allNodes.find(n => n.id === l.source);
        const targetNode = allNodes.find(n => n.id === l.target);
        return sourceNode && targetNode;
      });
    }

    if (!showOrphans) {
      allNodes = allNodes.filter(node => {
        if (node.id === activeFilePath) return true; // Always show active node
        const hasConnections = allLinks.some(l => l.source === node.id || l.target === node.id);
        return hasConnections;
      });
      allLinks = allLinks.filter(l => {
        const sourceNode = allNodes.find(n => n.id === l.source);
        const targetNode = allNodes.find(n => n.id === l.target);
        return sourceNode && targetNode;
      });
    }

    nodesRef.current = allNodes;
    linksRef.current = allLinks;
  }, [files, fileContents, activeFilePath, showCanvas, showGhosts, showOrphans]);

  // Keep canvas resolution in sync with parent element size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = containerRef.current || canvas.parentElement;
    if (!parent) return;

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const entry = entries[0];
      const { width, height } = entry.contentRect;
      canvas.width = width || parent.clientWidth || window.innerWidth;
      canvas.height = height || parent.clientHeight || window.innerHeight;
    });

    resizeObserver.observe(parent);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Main Force Directed Engine loop
  useEffect(() => {
    let animationFrameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const updatePhysics = () => {
      const nodes = nodesRef.current;
      const links = linksRef.current;

      const repulsionStrength = repulsionRef.current;
      const springStrength = 0.055;
      const springLength = springLengthRef.current;
      const gravity = gravityRef.current * 0.08;
      const friction = 0.8;

      // 1. Center of Gravity
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // 2. Node Repulsion (All nodes push each other away)
      for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i];
        if (n1 === dragNodeRef.current) continue; // Don't apply physics to dragged node

        for (let j = i + 1; j < nodes.length; j++) {
          const n2 = nodes[j];
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const distSqr = dx * dx + dy * dy || 1;
          const dist = Math.sqrt(distSqr);

          if (dist < 400) {
            // Stronger force at closer distance
            const force = (repulsionStrength / distSqr) * 15;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            n1.vx -= fx;
            n1.vy -= fy;
            n2.vx += fx;
            n2.vy += fy;
          }
        }

        // Pull to center
        n1.vx += (cx - n1.x) * gravity;
        n1.vy += (cy - n1.y) * gravity;
      }

      // 3. Link Attraction (Connected nodes pull together)
      links.forEach(link => {
        const sourceNode = nodes.find(n => n.id === link.source);
        const targetNode = nodes.find(n => n.id === link.target);

        if (sourceNode && targetNode) {
          const dx = targetNode.x - sourceNode.x;
          const dy = targetNode.y - sourceNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;

          // Hooke's spring force
          const force = (dist - springLength) * springStrength;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (sourceNode !== dragNodeRef.current) {
            sourceNode.vx += fx;
            sourceNode.vy += fy;
          }
          if (targetNode !== dragNodeRef.current) {
            targetNode.vx -= fx;
            targetNode.vy -= fy;
          }
        }
      });

      // 4. Apply Velocities with friction
      nodes.forEach(node => {
        if (node === dragNodeRef.current) return;

        node.vx *= friction;
        node.vy *= friction;

        node.x += node.vx;
        node.y += node.vy;
      });
    };

    const drawGraph = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      // Apply panning and zooming centered around center screen
      ctx.translate(canvas.width / 2 + panXRef.current, canvas.height / 2 + panYRef.current);
      ctx.scale(zoomRef.current, zoomRef.current);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);

      // Draw high-performance dynamic dotted grid background in world space
      const left = - (canvas.width / 2 + panXRef.current) / zoomRef.current + canvas.width / 2;
      const right = left + canvas.width / zoomRef.current;
      const top = - (canvas.height / 2 + panYRef.current) / zoomRef.current + canvas.height / 2;
      const bottom = top + canvas.height / zoomRef.current;

      const gridSize = 45;
      const startX = Math.floor(left / gridSize) * gridSize;
      const endX = Math.ceil(right / gridSize) * gridSize;
      const startY = Math.floor(top / gridSize) * gridSize;
      const endY = Math.ceil(bottom / gridSize) * gridSize;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
      for (let x = startX; x <= endX; x += gridSize) {
        for (let y = startY; y <= endY; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      const nodes = nodesRef.current;
      const links = linksRef.current;

      // Draw Links
      links.forEach(link => {
        const s = nodes.find(n => n.id === link.source);
        const t = nodes.find(n => n.id === link.target);
        if (s && t) {
          const activeNode = hoverNodeRef.current || touchActiveNodeRef.current;
          const isHighlighted = activeNode &&
            (activeNode.id === s.id || activeNode.id === t.id);

          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);

          if (activeNode) {
            if (isHighlighted) {
              ctx.strokeStyle = 'rgba(192, 132, 252, 0.95)';
              ctx.lineWidth = 2.2;
              ctx.globalAlpha = 1.0;
            } else {
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
              ctx.lineWidth = 0.8;
              ctx.globalAlpha = 0.15;
            }
          } else {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
            ctx.lineWidth = 1.1;
            ctx.globalAlpha = 1.0;
          }

          ctx.stroke();
        }
      });
      ctx.globalAlpha = 1.0; // Reset global alpha

      // Draw Nodes
      nodes.forEach(node => {
        const activeNode = hoverNodeRef.current || touchActiveNodeRef.current;
        const isHovered = activeNode && activeNode.id === node.id;
        const isRelated = !activeNode || isHovered || linksRef.current.some(
          l => (l.source === node.id && l.target === activeNode!.id) ||
               (l.source === activeNode!.id && l.target === node.id)
        );

        ctx.save();
        if (!isRelated) {
          ctx.globalAlpha = 0.15;
        } else {
          ctx.globalAlpha = 1.0;
        }

        const isActive = node.id === activeFilePath;
        const isSearched = searchHighlightRef.current && node.name.toLowerCase().includes(searchHighlightRef.current.toLowerCase());

        // Glow effects on hover, active, or search match state
        if (isHovered || isActive || isSearched) {
          ctx.save();
          ctx.shadowBlur = isSearched ? 25 : 18;
          ctx.shadowColor = isSearched ? '#10b981' : node.color;
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, 2 * Math.PI);

        if (node.type === 'ghost') {
          ctx.strokeStyle = isSearched ? '#10b981' : node.color;
          ctx.lineWidth = 1.8;
          ctx.stroke();
          ctx.fillStyle = 'rgba(71, 85, 105, 0.15)';
          ctx.fill();
        } else {
          ctx.fillStyle = isSearched ? '#10b981' : node.color;
          ctx.fill();
        }

        if (isHovered || isActive || isSearched) {
          ctx.restore();
          // Render ring border
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + (isSearched ? 5.5 : 3.5), 0, 2 * Math.PI);
          ctx.strokeStyle = isSearched ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = isSearched ? 1.5 : 0.9;
          ctx.stroke();
        }

        // Draw Labels
        if (zoomRef.current > 0.55 || isHovered || isSearched) {
          const fontSize = (isHovered || isSearched) ? 20 : 17;
          ctx.font = (isHovered || isSearched)
            ? 'bold 20px Inter, sans-serif'
            : '500 17px Inter, sans-serif';
          ctx.fillStyle = isSearched
            ? '#10b981'
            : (isHovered ? '#ffffff' : (node.type === 'ghost' ? 'rgba(241, 245, 249, 0.4)' : 'rgba(241, 245, 249, 0.65)'));
          ctx.textAlign = 'center';
          ctx.fillText(node.name, node.x, node.y - node.radius - (fontSize - 3));
        }

        ctx.restore();
      });

      ctx.restore();
    };

    const renderLoop = () => {
      updatePhysics();
      drawGraph();
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    renderLoop();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [activeFilePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = 1.08;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      const currentZoom = zoomRef.current;
      const currentPanX = panXRef.current;
      const currentPanY = panYRef.current;

      const worldXDiff = (mouseX - cx - currentPanX) / currentZoom;
      const worldYDiff = (mouseY - cy - currentPanY) / currentZoom;

      let newZoom = e.deltaY < 0 ? currentZoom * zoomFactor : currentZoom / zoomFactor;
      newZoom = Math.max(0.25, Math.min(newZoom, 2.5));

      const nextPanX = mouseX - cx - worldXDiff * newZoom;
      const nextPanY = mouseY - cy - worldYDiff * newZoom;

      zoomRef.current = newZoom;
      panXRef.current = nextPanX;
      panYRef.current = nextPanY;

      setZoom(newZoom);
    };

    canvas.addEventListener('wheel', handleWheelEvent, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheelEvent);
    };
  }, []);

  // Transform coordinates
  const screenToWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const worldX = (x - canvas.width / 2 - panXRef.current) / zoomRef.current + canvas.width / 2;
    const worldY = (y - canvas.height / 2 - panYRef.current) / zoomRef.current + canvas.height / 2;

    return { x: worldX, y: worldY };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    const { x, y } = screenToWorld(e.clientX, e.clientY);
    dragStartScreenRef.current = { x: e.clientX, y: e.clientY };

    // Check if clicked on a node
    const clickedNode = nodesRef.current.find(node => {
      const dx = node.x - x;
      const dy = node.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= node.radius + 16;
    });

    if (clickedNode) {
      dragNodeRef.current = clickedNode;
      isDraggingRef.current = true;
      clickedNode.vx = 0;
      clickedNode.vy = 0;
    } else {
      isDraggingRef.current = false;
      dragNodeRef.current = null;
    }

    mouseRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    const { x, y } = screenToWorld(e.clientX, e.clientY);

    const hoverNode = nodesRef.current.find(node => {
      const dx = node.x - x;
      const dy = node.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= node.radius + 16;
    });
    hoverNodeRef.current = hoverNode || null;

    if (dragNodeRef.current && isDraggingRef.current) {
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
    }
    else if (e.buttons === 1) {
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      panXRef.current += dx;
      panYRef.current += dy;
      mouseRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    if (dragNodeRef.current) {
      const dx = e.clientX - dragStartScreenRef.current.x;
      const dy = e.clientY - dragStartScreenRef.current.y;
      const distance = Math.hypot(dx, dy);

      if (distance < 6) {
        onOpenNote(dragNodeRef.current.id);
      }
    }
    dragNodeRef.current = null;
    isDraggingRef.current = false;
  };

  const handleTouchStart = React.useCallback((e: TouchEvent) => {
    isTouchRef.current = true;
    if (e.cancelable) {
      e.preventDefault();
    }

    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      initialPinchDistance.current = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      initialPinchZoom.current = zoomRef.current;
      touchActiveNodeRef.current = null;
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const { x, y } = screenToWorld(touch.clientX, touch.clientY);
    dragStartScreenRef.current = { x: touch.clientX, y: touch.clientY };

    const clickedNode = nodesRef.current.find(node => {
      const dx = node.x - x;
      const dy = node.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= node.radius + 24;
    });

    if (clickedNode) {
      dragNodeRef.current = clickedNode;
      touchActiveNodeRef.current = clickedNode;
      isDraggingRef.current = true;
      clickedNode.vx = 0;
      clickedNode.vy = 0;
    } else {
      isDraggingRef.current = false;
      dragNodeRef.current = null;
      touchActiveNodeRef.current = null;
    }

    mouseRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchMove = React.useCallback((e: TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistance.current !== null) {
      if (e.cancelable) {
        e.preventDefault();
      }
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      const scale = dist / initialPinchDistance.current;
      let newZoom = initialPinchZoom.current * scale;
      newZoom = Math.max(0.25, Math.min(newZoom, 2.5));
      zoomRef.current = newZoom;
      setZoom(newZoom);
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const { x, y } = screenToWorld(touch.clientX, touch.clientY);

    if (e.cancelable) {
      e.preventDefault();
    }

    if (dragNodeRef.current && isDraggingRef.current) {
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
    } else {
      const dx = touch.clientX - mouseRef.current.x;
      const dy = touch.clientY - mouseRef.current.y;
      panXRef.current += dx;
      panYRef.current += dy;
      mouseRef.current = { x: touch.clientX, y: touch.clientY };
    }
  }, []);

  const handleTouchEnd = React.useCallback((e: TouchEvent) => {
    initialPinchDistance.current = null;
    if (dragNodeRef.current) {
      const touch = e.changedTouches[0];
      if (touch) {
        const dx = touch.clientX - dragStartScreenRef.current.x;
        const dy = touch.clientY - dragStartScreenRef.current.y;
        const distance = Math.hypot(dx, dy);

        if (distance < 6) {
          onOpenNote(dragNodeRef.current.id);
        }
      }
    }
    dragNodeRef.current = null;
    isDraggingRef.current = false;
    touchActiveNodeRef.current = null;
    
    // If there's a remaining touch after pinch ends, update mouse position to prevent jump
    if (e.touches.length === 1) {
      const remainingTouch = e.touches[0];
      mouseRef.current = { x: remainingTouch.clientX, y: remainingTouch.clientY };
    }
    
    setTimeout(() => {
      isTouchRef.current = false;
    }, 50);
  }, [onOpenNote]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const resetViewport = () => {
    zoomRef.current = 1.0;
    panXRef.current = 0;
    panYRef.current = 0;
    setZoom(1);
  };

  return (
    <div ref={containerRef} className="w-full h-full relative bg-[oklch(0.08_0.015_260)] select-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      {/* Floating Gear Settings trigger button */}
      <div className="absolute top-6 left-6 z-20 select-none">
        <button
          onClick={() => setIsControlsOpen(!isControlsOpen)}
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center bg-card/65 backdrop-blur-xl border border-border text-muted-foreground hover:bg-border/60 hover:text-foreground shadow-2xl transition-all cursor-pointer",
            isControlsOpen && "border-primary text-primary"
          )}
          title="Graph Settings"
        >
          <Settings className={cn("w-5 h-5", isControlsOpen && "animate-spin")} style={{ animationDuration: '4s' }} />
        </button>

        {isControlsOpen && (
          <div className="absolute top-full left-0 mt-3 w-[280px] bg-card/90 backdrop-blur-xl border border-border rounded-2xl p-5 shadow-2xl flex flex-col gap-4.5 animate-in fade-in slide-in-from-top-3 duration-250 select-none">
            <div className="flex items-center gap-2.5 border-b border-border/80 pb-2">
              <SlidersHorizontal className="w-4 h-4 text-primary" />
              <span className="font-heading font-bold text-sm text-foreground">Graph Controls</span>
            </div>

            {/* Real-time search highlighting */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-0.5">Highlight Notes</span>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Type note name..."
                  value={searchHighlight}
                  onChange={(e) => setSearchHighlight(e.target.value)}
                  className="w-full bg-muted/40 border border-border text-foreground pl-9 pr-4 py-2 rounded-xl text-xs focus:outline-none focus:border-primary transition-all duration-200"
                />
              </div>
            </div>

            {/* Filter checkboxes */}
            <div className="flex flex-col gap-2">
              <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-0.5">Filters</span>

              <label className="flex items-center justify-between text-xs text-muted-foreground hover:text-foreground cursor-pointer py-1 px-0.5 transition-colors">
                <span className="font-medium">Show Canvas Notes</span>
                <input
                  type="checkbox"
                  checked={showCanvas}
                  onChange={(e) => setShowCanvas(e.target.checked)}
                  className="w-4 h-4 rounded border-border accent-primary cursor-pointer animate-none"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-muted-foreground hover:text-foreground cursor-pointer py-1 px-0.5 transition-colors">
                <span className="font-medium">Show Ghost Notes</span>
                <input
                  type="checkbox"
                  checked={showGhosts}
                  onChange={(e) => setShowGhosts(e.target.checked)}
                  className="w-4 h-4 rounded border-border accent-primary cursor-pointer animate-none"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-muted-foreground hover:text-foreground cursor-pointer py-1 px-0.5 transition-colors">
                <span className="font-medium">Show Orphan Notes</span>
                <input
                  type="checkbox"
                  checked={showOrphans}
                  onChange={(e) => setShowOrphans(e.target.checked)}
                  className="w-4 h-4 rounded border-border accent-primary cursor-pointer animate-none"
                />
              </label>
            </div>

            {/* Force adjusters sliders */}
            <div className="flex flex-col gap-3">
              <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-0.5">Forces (Physics)</span>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[0.7rem] text-muted-foreground font-semibold">
                  <span>Node Repulsion</span>
                  <span className="text-foreground">{repulsionStrength}</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="400"
                  value={repulsionStrength}
                  onChange={(e) => setRepulsionStrength(Number(e.target.value))}
                  className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[0.7rem] text-muted-foreground font-semibold">
                  <span>Link Distance</span>
                  <span className="text-foreground">{springLength}px</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="250"
                  value={springLength}
                  onChange={(e) => setSpringLength(Number(e.target.value))}
                  className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[0.7rem] text-muted-foreground font-semibold">
                  <span>Gravity</span>
                  <span className="text-foreground">{(gravity * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.005"
                  max="0.08"
                  step="0.005"
                  value={gravity}
                  onChange={(e) => setGravity(Number(e.target.value))}
                  className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>
            </div>

            {/* Map Legend */}
            <div className="flex flex-col gap-2.5 border-t border-border/80 pt-3">
              <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-0.5">Node Legend</span>
              
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 bg-[#8b5cf6] rounded-full shrink-0 shadow-[0_0_6px_#8b5cf6]" />
                <span className="text-xs text-muted-foreground">Markdown Note</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 bg-[#0d9488] rounded-full shrink-0 shadow-[0_0_6px_#0d9488]" />
                <span className="text-xs text-muted-foreground">Obsidian Canvas</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 bg-[#ef4444] rounded-full shrink-0 shadow-[0_0_6px_#ef4444]" />
                <span className="text-xs text-muted-foreground">Obsidian Base</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 bg-[#c084fc] rounded-full shrink-0 shadow-[0_0_8px_#c084fc]" />
                <span className="text-xs text-muted-foreground">Active Note</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 rounded-full border-2 border-[#475569] bg-[rgba(71,85,105,0.15)] shrink-0" />
                <span className="text-xs text-muted-foreground">Ghost Note</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Canvas controls */}
      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 sm:bottom-6 sm:right-6 flex items-center gap-1.5 z-50 bg-card/60 backdrop-blur-xl border border-border px-3 py-2 rounded-full shadow-2xl animate-fade-in select-none max-w-[calc(100%-2rem)] overflow-x-auto flex-nowrap no-scrollbar">
        <button
          onClick={() => {
            const nextZoom = Math.min(zoomRef.current * 1.15, 2.5);
            zoomRef.current = nextZoom;
            setZoom(nextZoom);
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer border border-transparent hover:border-border"
          title="Zoom In"
        >
          <ZoomIn size={14.5} />
        </button>
        <button
          onClick={() => {
            const nextZoom = Math.max(zoomRef.current / 1.15, 0.25);
            zoomRef.current = nextZoom;
            setZoom(nextZoom);
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer border border-transparent hover:border-border"
          title="Zoom Out"
        >
          <ZoomOut size={14.5} />
        </button>
        <div className="w-[1px] h-4 bg-border mx-0.5" />
        <button
          onClick={resetViewport}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer border border-transparent hover:border-border"
          title="Recenter Graph"
        >
          <Maximize2 size={14.5} />
        </button>
        {onPrefetchAll && (
          <>
            <div className="w-[1px] h-4 bg-border mx-0.5" />
            <button
              onClick={onPrefetchAll}
              disabled={prefetchStatus === 'fetching'}
              className={cn(
                "h-8 px-3 rounded-full flex items-center justify-center gap-1.5 text-xs font-semibold cursor-pointer transition-all shrink-0 border border-transparent hover:border-border/10",
                prefetchStatus === 'fetching'
                  ? "bg-primary/20 text-accent border border-primary/20 animate-pulse-soft"
                  : prefetchStatus === 'success'
                    ? "bg-accent/20 text-accent border border-accent/25"
                    : prefetchStatus === 'error'
                      ? "bg-destructive/20 text-destructive border border-destructive/25"
                      : "text-muted-foreground hover:bg-border/60 hover:text-foreground"
              )}
              title="Prefetch all vault files & backlinks"
            >
              <RefreshCw size={12} className={cn(prefetchStatus === 'fetching' && "animate-spin")} />
              <span className="text-[0.7rem] font-bold">
                {prefetchStatus === 'fetching'
                  ? `Prefetching (${prefetchProgress.loaded}/${prefetchProgress.total})`
                  : prefetchStatus === 'success'
                    ? 'Prefetched!'
                    : prefetchStatus === 'error'
                      ? 'Prefetch Error'
                      : 'Prefetch All'}
              </span>
            </button>
          </>
        )}
      </div>

      {/* Floating Map Legend block */}
      <div className="absolute top-6 right-6 p-4 bg-card/65 backdrop-blur-xl border border-border rounded-xl flex flex-col gap-2.5 text-xs text-muted-foreground font-semibold shadow-2xl select-none z-10 hidden sm:flex">
        <span className="text-foreground border-b border-border/80 pb-1.5 font-bold tracking-wide">
          Map Legend
        </span>
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 bg-[#8b5cf6] rounded-full shrink-0 shadow-[0_0_6px_#8b5cf6]" />
          <span>Markdown Note</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 bg-[#0d9488] rounded-full shrink-0 shadow-[0_0_6px_#0d9488]" />
          <span>Obsidian Canvas</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 bg-[#ef4444] rounded-full shrink-0 shadow-[0_0_6px_#ef4444]" />
          <span>Obsidian Base</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 bg-[#c084fc] rounded-full shrink-0 shadow-[0_0_8px_#c084fc]" />
          <span>Active Note</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full border-2 border-[#475569] bg-[rgba(71,85,105,0.15)] shrink-0" />
          <span>Ghost Note</span>
        </div>
      </div>
    </div>
  );
};
export const GraphView = React.memo(GraphViewComponent);
