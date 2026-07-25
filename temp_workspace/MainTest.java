import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class MainTest {

    @Test
    void testCalculateSum() {
        int result = Main.calculateSum(10, 20);
        assertEquals(30, result, "10 + 20 should equal 30");
    }

    @Test
    void testNegativeSum() {
        int result = Main.calculateSum(-5, 5);
        assertEquals(0, result, "-5 + 5 should equal 0");
    }
     @Test
    void testNegativeSum2() {
        int result = Main.calculateSum(25, 5);
        assertEquals(30, result, "-5 + 5 should equal 0");
    }
}