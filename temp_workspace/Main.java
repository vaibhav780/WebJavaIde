import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        System.out.println("Enter your name: ");
        String name = scanner.nextLine();
        
        System.out.println("Enter first number: ");
        int a = scanner.nextInt();
        
        System.out.println("Enter second number: ");
        int b = scanner.nextInt();
        
        int sum = calculateSum(a, b);
        
        System.out.println("\nHello " + name + ", the calculated sum is: " + sum);
    }

    public static int calculateSum(int x, int y) {
        return x + y;
    }
}