import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        System.out.print("Enter your name: ");
        String name = scanner.nextLine();
        
        int a = 10;
        int b = 20;
        int sum = calculateSum(a, b);
        
        System.out.println("Hello " + name + ", sum is: " + sum);
    }

    public static int calculateSum(int x, int y) {
        return x + y;
    }
}