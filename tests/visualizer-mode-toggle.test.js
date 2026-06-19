import visualizer from '../dj/visualizer';

describe('Visualizer Mode Toggle', () => {
    let container;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'visualizer-container';
        document.body.appendChild(container);
        visualizer.init('visualizer-container');
    });

    afterEach(() => {
        document.body.removeChild(container);
        visualizer.isFullscreen = true; // Reset to default state
    });

    test('should initialize in fullscreen mode', () => {
        expect(visualizer.isFullscreen).toBe(true);
        expect(visualizer.canvas.width).toBe(window.innerWidth);
        expect(visualizer.canvas.height).toBe(window.innerHeight);
    });

    test('should toggle to windowed mode and resize canvas', () => {
        visualizer.toggleFullscreen();
        expect(visualizer.isFullscreen).toBe(false);
        expect(visualizer.canvas.width).toBe(800);
        expect(visualizer.canvas.height).toBe(600);
    });

    test('should toggle back to fullscreen mode and resize canvas', () => {
        visualizer.toggleFullscreen(); // Switch to windowed
        visualizer.toggleFullscreen(); // Switch back to fullscreen
        expect(visualizer.isFullscreen).toBe(true);
        expect(visualizer.canvas.width).toBe(window.innerWidth);
        expect(visualizer.canvas.height).toBe(window.innerHeight);
    });
});